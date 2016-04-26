"use strict";


/**
 * restbase-mod-queue-kafka main entry point
 */


const P = require('bluebird');
const HTTPError = require('hyperswitch').HTTPError;
const uuid = require('cassandra-uuid').TimeUuid;

const Rule = require('../lib/rule');
const KafkaFactory = require('../lib/kafka_factory');
const RuleExecutor = require('../lib/rule_executor');

class Kafka {
    constructor(options) {
        this.log = options.log || function() { };
        this.kafkaFactory = new KafkaFactory({
            uri: options.uri || 'localhost:2181/',
            clientId: options.client_id || 'change-propagation',
            consume_dc: options.consume_dc,
            produce_dc: options.produce_dc
        });
        this.staticRules = options.templates || {};
        this.ruleExecutors = {};
    }

    setup(hyper) {
        return this.kafkaFactory.newProducer(this.kafkaFactory.newClient())
        .then((producer) => {
            this.producer = producer;
            return P.all(Object.keys(this.staticRules)
            .map((ruleName) => new Rule(ruleName, this.staticRules[ruleName]))
            .filter((rule) => !rule.noop)
            .map((rule) => {
                this.ruleExecutors[rule.name] = new RuleExecutor(rule,
                    this.kafkaFactory, hyper, this.log);
                return this.ruleExecutors[rule.name].subscribe();
            }))
            .tap(() => this.log('info/change-prop/init', 'Kafka Queue module initialised'));
        })
        .thenReturn({ status: 200 });
    }

    produce(hyper, req) {
        const messages = req.body;
        if (!Array.isArray(messages)) {
            throw new HTTPError({
                status: 400,
                body: {
                    type: 'bad_request',
                    detail: 'Events should be an array'
                }
            });
        }
        const groupedPerTopic = messages.reduce((result, message) => {
            if (!message || !message.meta || !message.meta.topic) {
                throw new HTTPError({
                    status: 400,
                    body: {
                        type: 'bad_request',
                        detail: 'Event must have a meta.topic property',
                        event: message
                    }
                });
            }
            const topic = message.meta.topic;
            result[topic] = result[topic] || [];
            const now = new Date();
            message.meta.id = message.meta.id || uuid.fromDate(now).toString();
            message.meta.dt = message.meta.dt || now.toISOString();
            result[topic].push(JSON.stringify(message));
            return result;
        }, {});

        return this.producer.sendAsync(Object.keys(groupedPerTopic).map((topic) => {
            const prefixedTopic = this.kafkaFactory.produceDC ?
                `${this.kafkaFactory.produceDC}.${topic}` : topic;
            return {
                topic: prefixedTopic,
                messages: groupedPerTopic[topic]
            };
        }))
        .thenReturn({ status: 201 });
    }
}

module.exports = (options) => {
    const kafkaMod = new Kafka(options);
    return {
        spec: {
            paths: {
                '/setup': {
                    put: {
                        summary: 'set up the kafka listener',
                        operationId: 'setup_kafka'
                    }
                },
                '/events': {
                    post: {
                        summary: 'produces a message the kafka topic',
                        operationId: 'produce'
                    }
                }
            }
        },
        operations: {
            setup_kafka: kafkaMod.setup.bind(kafkaMod),
            produce: kafkaMod.produce.bind(kafkaMod)
        },
        resources: [{
            uri: '/sys/queue/setup'
        }]
    };
};

