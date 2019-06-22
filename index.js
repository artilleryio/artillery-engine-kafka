const kafka = require('kafka-node');
const debug = require('debug')('engine:kafka');
const A = require('async');
const _ = require('lodash');

const getPayload = length => Buffer.alloc(length,
  Math.random()
    .toString(36)
    .replace(/[^a-z]+/g, '')
    .substr(0, 1));
const { log: logger } = console;

const DEFAULT_MESSAGE_SIZE = 300;

function KafkaEngine(script, ee, helpers) {
  this.script = script;
  this.ee = ee;
  this.helpers = helpers;

  return this;
}

KafkaEngine.prototype.createScenario = function createScenario(scenarioSpec, ee) {
  const tasks = scenarioSpec.flow.map(rs => this.step(rs, ee));

  return this.compile(tasks, scenarioSpec.flow, ee);
};

KafkaEngine.prototype.step = function step(rs, ee) {
  const self = this;

  if (rs.loop) {
    const steps = rs.loop.map(loopStep => this.step(loopStep, ee));

    return this.helpers.createLoopWithCount(rs.count || -1, steps, {});
  }

  if (rs.log) {
    return function log(context, callback) {
      logger(rs.log);
      // console.log(template(rs.log, context));
      return process.nextTick(() => { callback(null, context); });
    };
  }

  if (rs.think) {
    return this.helpers.createThink(rs, _.get(self.config, 'defaults.think', {}));
  }

  if (rs.publishMessage) {
    return function publishMessage(context, callback) {
      const batchSize = Number(rs.publishMessage.batch) || 1;
      let data;

      if (rs.publishMessage.data) {
        data = typeof rs.publishMessage.data === 'object'
          ? JSON.stringify(rs.publishMessage.data)
          : String(rs.publishMessage.data);
      } else {
        data = getPayload(
          Number(rs.publishMessage.size) || DEFAULT_MESSAGE_SIZE
        );
      }

      const message = {
        topic: rs.publishMessage.topic,
        messages: new Array(batchSize).fill().map(() => data),
      };

      context.kafka.producer.send([message], (err) => {
        if (err) {
          ee.emit('error', err);
          debug(err);

          return callback(err, context);
        }

        ee.emit('response', 0, 0, context._uid);

        return callback(null, context);
      });
    };
  }

  return function s(context, callback) {
    return callback(null, context);
  };
};

KafkaEngine.prototype.compile = function compile(tasks, scenarioSpec, ee) {
  const self = this;

  return function scenario(initialContext, callback) {
    const init = function init(next) {
      if (!((self.script.config.kafka || {}).client || {}).kafkaHost) {
        throw new Error('kafka.client.kafkaHost is required');
      }

      const { kafka: { client: opts } } = self.script.config;

      const kafkaClient = new kafka.KafkaClient(opts);
      const producer = new (kafka.HighLevelProducer)(kafkaClient);

      producer.on('error', (err) => {
        ee.emit('error', err);
      });

      producer.on('ready', () => {
        ee.emit('started');

        next(null, Object.assign(initialContext, {
          kafka: {
            producer
          }
        }));
      });
    };

    const steps = [init].concat(tasks);

    A.waterfall(
      steps,
      (err, context) => {
        if (err) {
          debug(err);
        }

        return callback(err, context);
      },
    );
  };
};

module.exports = KafkaEngine;
