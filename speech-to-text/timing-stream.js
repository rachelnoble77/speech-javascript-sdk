'use strict';

var Duplex = require('stream').Duplex;
var util = require('util');
var clone = require('clone');

/**
 * Slows results down to no faster than real time.
 *
 * Useful when running recognizeBlob because the text can otherwise appear before the words are spoken
 *
 * @param {Object} opts
 * @param {*} [opts.emitAtt=TimingStream.START] - set to TimingStream.END to only emit text that has been completely spoken.
 * @param {Number} [opts.delay=0] - Additional delay (in seconds) to apply before emitting words, useful for precise syncing to audio tracks. May be negative
 * @param {Boolean} [options.objectMode=false] - emit `result` objects instead of string Buffers for the `data` events.
 * @constructor
 */
function TimingStream(opts) {
  this.opts = util._extend({
    emitAt: TimingStream.START,
    delay: 0,
    allowHalfOpen: true, // keep the readable side open after the source closes
    objectMode: false
  }, opts);
  Duplex.call(this, opts);

  this.startTime = Date.now();
  // buffer to store future results
  this.final = [];
  this.interim = [];
  this.nextTick = null;
  this.sourceEnded = false;

  var self = this;
  this.on('pipe', function(source) {
    source.on('result', self.handleResult.bind(self));
    if(source.stop) {
      self.stop = source.stop.bind(source);
    }
    source.on('end', function() {
      self.sourceEnded = true;
    });
  });
}
util.inherits(TimingStream, Duplex);

TimingStream.START = 1;
TimingStream.END = 2;

TimingStream.prototype._write = function(chunk, encoding, next) {
  // ignore - we'll emit our own final text based on the result events
  next();
};

TimingStream.prototype._read = function(size) {
  // ignore - we'll emit results once the time has come
};

TimingStream.prototype.cutoff = function cutoff() {
  return (Date.now() - this.startTime)/1000 - this.opts.delay;
};

TimingStream.prototype.withinRange = function(result, cutoff) {
  return result.alternatives.some(function(alt) {
    // timestamp structure is ["word", startTime, endTime]
    // if the first timestamp ends before the cutoff, then it's at least partially within range
    var timestamp = alt.timestamps[0];
    return !!timestamp && timestamp[this.opts.emitAt] <= cutoff;
  }, this);
};

TimingStream.prototype.completelyWithinRange = function(result, cutoff) {
  return result.alternatives.every(function(alt) {
    // timestamp structure is ["word", startTime, endTime]
    // if the last timestamp ends before the cutoff, then it's completely within range
    var timestamp = alt.timestamps[alt.timestamps.length - 1];
    return timestamp[this.opts.emitAt] <= cutoff;
  }, this);
};

/**
 * Clones the given result and then crops out any words that occur later than the current cutoff
 * @param result
 */
Duplex.prototype.crop = function crop(result, cutoff) {
  result = clone(result);
  result.alternatives = result.alternatives.map(function(alt) {
    var timestamps = [];
    for (var i=0, timestamp; i<alt.timestamps.length; i++) {
      timestamp = alt.timestamps[i];
      if (timestamp[this.opts.emitAt] <= cutoff) {
        timestamps.push(timestamp);
      } else {
        break;
      }
    }
    alt.timestamps = timestamps;
    alt.transcript = timestamps.map(function(ts) {
      return ts[0];
    }).join(' ');
    return alt;
  }, this);
  // "final" signifies both that the text won't change, and that we're at the end of a sentence. Only one of those is true here.
  result.final = false;
  return result
};

/**
 * Returns one of:
 *  - undefined if the next result is completely later than the current cutoff
 *  - a cropped clone of the next result if it's later than the current cutoff
 *  - the original next result object (removing it from the array) if it's completely earlier than the current cutoff
 *
 * @param results
 * @param cutoff
 * @returns {*}
 */
TimingStream.prototype.getCurrentResult = function getCurrentResult(results, cutoff) {
  if (results.length && this.withinRange(results[0], cutoff)) {
    return this.completelyWithinRange(results[0], cutoff) ? results.shift() : this.crop(results[0], cutoff);
  }
};


/**
 * Tick emits any buffered words that have a timestamp before the current time, then calls scheduleNextTick()
 */
TimingStream.prototype.tick = function tick() {
  var cutoff = this.cutoff();

  clearTimeout(this.nextTick);
  var result = this.getCurrentResult(this.final, cutoff);

  if (!result) {
    result = this.getCurrentResult(this.interim, cutoff);
  }

  if(result) {
    this.emit('result', result);
    if (result.final) {
      this.push(result.alternatives[0].transcript);
      return this.nextTick = setTimeout(this.tick.bind(this), 0); // in case we are multiple results behind - don't schedule until we are out of final results that are due now
    }
  }

  this.scheduleNextTick(cutoff);
};

/**
 * Schedules next tick if possible.
 *
 * triggers the 'close' and 'end' events if the buffer is empty and no further results are expected
 *
 * @param cutoff
 */
TimingStream.prototype.scheduleNextTick = function scheduleNextTick(cutoff) {

  // prefer final results over interim - when final results are added, any older interim ones are automatically deleted.
  var nextResult = this.final[0] || this.interim[0];
  if (nextResult) {
    // loop through the timestamps until we find one that comes after the current cutoff (there should always be one)
    var timestamps = nextResult.alternatives[0].timestamps;
    for(var i=0; i<timestamps.length; i++) {
      var wordOffset = timestamps[i][this.opts.emitAt];
      if (wordOffset > cutoff) {
        return this.nextTick = setTimeout(this.tick.bind(this), this.startTime + (wordOffset*1000));
      }
    }
    throw new Error('No future words found'); // this shouldn't happen ever - getCurrentResult should automatically delete the result from the buffer if all of it's words are consumed
  } else {
    // if we have no next result in the buffer, and the source has ended, then we're done.
    if (this.sourceEnded) {
      this.emit('close');
      this.push(null);
    }
  }
};

function noTimestamps(result) {
  var alt = result.alternatives && result.alternatives[0];
  return alt && alt.transcript.trim() && !alt.timestamps || !alt.timestamps.length;
}

/**
 * Creates a new result with all transcriptions formatted
 *
 * @param result
 */
TimingStream.prototype.handleResult = function handleResult(result) {
  if (noTimestamps(result)) {
    throw new Error('TimingStream requires timestamps');
  }

  // additional alternatives do not include timestamps, so we can't process and emit them correctly
  if (result.alternatives.length > 1) {
    result.alternatives.length = 1;
  }

  // loop through the buffer and delete any interiml results with the same or lower index
  while(this.interim.length && this.interim[0].index <= result.index) {
    this.interim.shift();
  }

  if (result.final) {
    // then add it to the final results array
    this.final.push(result);
  } else {
    this.interim.push(result);
  }

  this.tick();
};

TimingStream.prototype.stop = function(){}; // usually overwritten during the `pipe` event


module.exports = TimingStream;
