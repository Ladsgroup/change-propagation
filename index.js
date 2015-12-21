"use strict";


/**
 * restbase-mod-queue-kafka main entry point
 */


var P = require('bluebird');
var kafka = P.promisifyAll(require('kafka-node'));
var uuid = require('cassandra-uuid');
var Template = require('swagger-router').Template;
var preq = require('preq');


function Kafka(options) {

    this.log = options.log || function() {};
    this.conf = {
        host: options.host || 'localhost',
        port: options.port || 2181,
        clientId: options.client_id || 'change-propagation',
        rules: options.templates || {}
    };
    this.conf.connString = this.conf.host + ':' + this.conf.port;
    this.rules = {};

    // init the rules
    this._init();

}


Kafka.prototype._processRule = function(ruleName, ruleSpec) {

    var idx;
    var reqs;
    var templates = [];

    // validate the rule spec
    if (!ruleSpec.topic) {
        throw new Error('No topic specified for rule ' + ruleName);
    }
    if (!ruleSpec.exec) {
        // nothing to do, ignore this rule
        return undefined;
    }
    if (!Array.isArray(ruleSpec.exec)) {
        ruleSpec.exec = [ruleSpec.exec];
    }

    reqs = ruleSpec.exec;
    for (idx = 0; idx < reqs.length; idx++) {
        var req = reqs[idx];
        if (req.constructor !== Object || !req.uri) {
            throw new Error('In rule ' + ruleName + ', request number ' + idx +
                ' must be an object and must have the "uri" property');
        }
        req.method = req.method || 'get';
        req.headers = req.headers || {};
        templates.push(new Template(req));
    }

    return {
        topic: ruleSpec.topic,
        exec: templates
    };

};


Kafka.prototype._init = function() {

    Object.keys(this.conf.rules).forEach(function(name) {
        var rule = this._processRule(name, this.conf.rules[name]);
        if (!rule) { return; }
        this.rules[name] = rule;
    }, this);

};


Kafka.prototype.setup = function() {

    var self = this;

    self.conn = {};
    var p = Object.keys(self.rules).map(function(rule) {
        var ruleDef = self.rules[rule];
        self.conn[rule] = {};
        self.conn[rule].client = new kafka.Client(
            self.conf.connString,
            self.conf.clientId + '-' + uuid.TimeUuid.now() + '-' + uuid.Uuid.random(),
            {}
        );
        self.conn[rule].consumer = new kafka.HighLevelConsumer(
            self.conn[rule].client,
            [{ topic: ruleDef.topic }],
            { groupId: 'change-prop-' + rule }
        );
        self.conn[rule].consumer.on('message', function(message) {
            var event = JSON.parse(message.value);
            self.log('debug/kafka/message',
                { msg: 'Event received', event: event }
            );
            return P.each(ruleDef.exec, P.method(function(tpl) {
                return preq(tpl.expand({message: event}));
            })).catch(function(err) {
                self.log('info/change-prop', err);
            });
        });
        self.conn[rule].consumer.on('error', function(err) {
            self.log('warn/kafka/error', {err: err});
        });
        return new P(function(resolve) {
            self.conn[rule].consumer.on('rebalanced', function() {
                self.log('debug/kafka/topic', 'Listening to topic ' + ruleDef.topic
                    + ' for rule ' + rule);
                resolve();
            });
        });
    });

    return P.all(p).then(function() {
        self.log('info/kafka/init', 'Kafka Queue module initialised');
    });

};


module.exports = function(options) {

    var kafkaMod = new Kafka(options);

    return kafkaMod.setup().then(function() {
        return {
            /* We currently don't expose anything to RESTBase, because only static
            * rule definitions are supported. In future, this module will expose
            * routes allowing for dynamic subscriptions.
            */
            spec: {},
            operations: {}
        };
    });

};

