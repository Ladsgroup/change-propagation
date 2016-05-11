"use strict";

const P = require('bluebird');
const uuid = require('cassandra-uuid').TimeUuid;
const TopicsNotExistError = require('wmf-kafka-node/lib/errors').TopicsNotExistError;

/**
 * A rule executor managing matching and execution of a single rule
 */
class RuleExecutor {
    /**
     * Creates a new instance of a rule executor
     *
     * @param {Rule} rule
     * @param {KafkaFactory} kafkaFactory
     * @param {Object} hyper
     * @param {function} log
     * @constructor
     */
    constructor(rule, kafkaFactory, hyper, log) {
        this.rule = rule;
        this.kafkaFactory = kafkaFactory;
        this.hyper = hyper;
        this.log = log;
    }

    _setConsumerLoggers(consumer, ruleName, topic) {
        consumer.on('topics_changed', (topicList) => {
            // only one topic can be subscribed to by this client
            if (topicList && topicList.length) {
                this.log(`info/subscription/${ruleName}`, {
                    rule: { name: ruleName, topic },
                    msg: `Listening to ${topicList[0]}`
                });
            } else {
                this.log(`info/subscription/${ruleName}`, {
                    rule: { name: ruleName, topic },
                    msg: `Lost ownership of ${topic}`
                });
            }
        });
        consumer.on('error', (err) => this.log(`warn/error/${ruleName}`, {
            err,
            rule: { name: ruleName, topic }
        }));
        return consumer;
    }

    _test(event) {
        if (this.rule.test(event)) {
            return true;
        }
        // no match, drop the message
        this.log(`debug/${this.rule.name}`, { msg: 'Dropping event message', event: event });
        return false;
    }

    _exec(event, statName, statDelayStartTime) {
        const rule = this.rule;

        this.log(`trace/${rule.name}`, { msg: 'Event message received', event: event });

        // latency from the original event creation time to execution time
        this.hyper.metrics.endTiming([statName + '_delay'],
            statDelayStartTime || new Date(event.meta.dt));

        const startTime = Date.now();
        const expander = {
            message: event,
            match: rule.expand(event)
        };
        return P.each(rule.exec, (tpl) => this.hyper.request(tpl.expand(expander)))
        .finally(() => {
            this.hyper.metrics.endTiming([statName + '_exec'], startTime);
        });
    }

    _safeParse(message) {
        try {
            return JSON.parse(message);
        } catch (e) {
            this.log(`error/${this.rule.name}`, e);
        }
    }

    _retryTopicName() {
        return 'change-prop.retry.' + this.rule.topic;
    }

    _isLimitExceeded(message) {
        if (message.retries_left <= 0) {
            this.log(`error/${this.rule.name}`, {
                message: 'Retry count exceeded',
                event: message
            });
            return true;
        }
        return false;
    }
    /**
     * Set's up a consumer a retry queue
     *
     * @private
     */
    _setUpRetryTopic() {
        const retryTopicName = this._retryTopicName();

        return this.kafkaFactory.newConsumer(this.kafkaFactory.newClient(),
            retryTopicName,
            `change-prop-${retryTopicName}-${this.rule.name}`)
        .then((consumer) => {
            this.retryConsumer = this._setConsumerLoggers(consumer, this.rule.name, retryTopicName);
            this.retryConsumer.on('message', (msg) => {
                const statName = this.hyper.metrics.normalizeName(this.rule.name + '_retry');
                let message;
                return P.try(() => {
                    message = this._safeParse(msg.value);
                    if (!message) {
                        // Don't retry if we can't parse an event, just log.
                        return;
                    }

                    if (message.emitter_id !== this._consumerId()) {
                        // Not our business, don't care
                        return;
                    }

                    if (this._isLimitExceeded(message)) {
                        // We've don our best, give up
                        return;
                    }

                    if (!this._test(message.original_event)) {
                        // doesn't match any more, possibly meaning
                        // the rule has been changed since we last
                        // executed it on the message
                        return;
                    }

                    return this._exec(message.original_event, statName, new Date(message.meta.dt))
                    .catch((e) => {
                        const retryMessage = this._constructRetryMessage(message.original_event,
                            e, message.retries_left - 1);
                        if (this.rule.shouldRetry(e) && !this._isLimitExceeded(retryMessage)) {
                            return this._retry(retryMessage);
                        }
                    });
                })
                .then(() => this.retryConsumer.commitAsync());
            });
        });
    }

    _retry(retryMessage) {
        const spec = this.rule.spec;
        const delay = spec.retry_delay *
            Math.pow(spec.retry_factor, spec.retry_limit - retryMessage.retries_left);
        return P.delay(delay)
        .then(() => {
            const now = new Date();
            retryMessage.meta.id = uuid.fromDate(now).toString();
            retryMessage.meta.dt = now.toISOString();
            return this.hyper.post({
                uri: '/sys/queue/events',
                body: [ retryMessage ]
            });
        });
    }

    _consumerId() {
        return 'change-prop#' + this.rule.name;
    }

    _constructRetryMessage(event, errorRes, retriesLeft) {
        return {
            meta: {
                topic: this._retryTopicName(),
                schema_uri: 'retry/1',
                uri: event.meta.uri,
                request_id: event.meta.request_id,
                id: undefined, // will be filled later
                dt: undefined, // will be filled later
                domain: event.meta.domain
            },
            emitter_id: this._consumerId(),
            retries_left: retriesLeft === undefined ? this.rule.spec.retry_limit : retriesLeft,
            original_event: event,
            reason: errorRes && errorRes.body && errorRes.body.title
        };
    }

    subscribe() {
        const rule = this.rule;
        const client = this.kafkaFactory.newClient();
        return this._setUpRetryTopic()
        .then(() => {
            return this.kafkaFactory.newConsumer(client, rule.topic, `change-prop-${rule.name}`)
            .then((consumer) => {
                this.consumer = this._setConsumerLoggers(consumer, rule.name, rule.topic);
                this.consumer.on('message', (msg) => {
                    const statName = this.hyper.metrics.normalizeName(this.rule.name);
                    let message;
                    return P.try(() => {
                        message = this._safeParse(msg.value);
                        if (!message || !this._test(message)) {
                            // no message or no match, we are done here
                            return;
                        }

                        return this._exec(message, statName)
                        .catch((e) => {
                            if (this.rule.shouldRetry(e)) {
                                return this._retry(this._constructRetryMessage(message, e));
                            }
                        });
                    })
                    .then(() => this.consumer.commitAsync());
                });
            });
        })
        .catch(TopicsNotExistError, (e) => {
            this.log('error/topic', e);
            // Exit async to let the logs get processed.
            setTimeout(() => process.exit(1), 100);
        });
    }
}

module.exports = RuleExecutor;
