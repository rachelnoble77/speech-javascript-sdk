/**
 * Copyright 2014 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';


var Duplex = require('stream').Duplex;
var util = require('util');
var pick = require('object.pick');
var W3CWebSocket = require('websocket').w3cwebsocket;
var contentType = require('./content-type');


var OPENING_MESSAGE_PARAMS_ALLOWED = ['continuous', 'max_alternatives', 'timestamps', 'word_confidence', 'inactivity_timeout',
  'content-type', 'interim_results', 'keywords', 'keywords_threshold', 'word_alternatives_threshold'];

var QUERY_PARAMS_ALLOWED = ['model', 'watson-token']; //, 'X-Watson-Learning-Opt-Out' - should be allowed but currently isn't due to a service bug


/**
 * pipe()-able Node.js Readable/Writeable stream - accepts binary audio and emits text in it's `data` events.
 * Also emits `results` events with interim results and other data.
 *
 * Cannot be instantiated directly, instead reated by calling #createRecognizeStream()
 *
 * Uses WebSockets under the hood. For audio with no recognizable speech, no `data` events are emitted.
 * @param options
 * @param {String} [options.model='en-US_BroadbandModel'] - voice model to use. Microphone streaming only supports broadband models.
 * @param {String} [options.url='wss://stream.watsonplatform.net/speech-to-text/api'] base URL for service
 * @param {String} [options.content-type='audio/wav'] - content type of audio; can be automatically determined from file header in most cases. only wav, flac, and ogg/opus are supported
 * @param {Boolean} [options.interim_results=false] - Send back non-final previews of each "sentence" as it is being processed. Defaults to true when in objectMode.
 * @param {Boolean} [options.continuous=true] - set to false to automatically stop the transcription after the first "sentence"
 * @param {Boolean} [options.word_confidence=false] - include confidence scores with results. Defaults to true when in objectMode.
 * @param {Boolean} [options.timestamps=false] - include timestamps with results. Defaults to true when in objectMode.
 * @param {Number} [options.max_alternatives=1] - maximum number of alternative transcriptions to include. Defaults to 3 when in objectMode.
 * @param {Number} [options.inactivity_timeout=30] - how many seconds of silence before automatically closing the stream (even if continuous is true). use -1 for infinity
 * @param {Boolean} [options.objectMode=false] - emit `result` objects instead of string Buffers for the `data` events. Changes several other defaults.
 *
 * //todo: investigate other options at http://www.ibm.com/smarterplanet/us/en/ibmwatson/developercloud/apis/#!/speech-to-text/recognizeSessionless
 *
 * @constructor
 */
function RecognizeStream(options) {
  Duplex.call(this, {readableObjectMode: options && (options.objectMode || options.readableObjectMode)});
  this.options = options;
  this.listening = false;
  this.initialized = false;
  this.finished = false;
  var self = this;

  // listening for `results` events should put the stream in flowing mode just like `data` events
  function flowForResults(event) {
    if (event == 'results' || event == 'result') {
      self.removeListener('newListener', flowForResults);
      process.nextTick(function () {
        self.on('data', function () {
        }); // todo: is there a better way to put a stream in flowing mode?
      });
    }
  }
  this.on('newListener', flowForResults);
}
util.inherits(RecognizeStream, Duplex);


RecognizeStream.prototype.initialize = function () {
  var options = this.options;

  // todo: apply these corrections to other methods (?)
  if (options.token && !options['watson-token']) {
    options['watson-token'] = options.token;
  }
  if (options.content_type && !options['content-type']) {
    options['content-type'] = options.content_type;
  }
  if (options['X-WDC-PL-OPT-OUT'] && !options['X-Watson-Learning-Opt-Out']) {
    options['X-Watson-Learning-Opt-Out'] = options['X-WDC-PL-OPT-OUT'];
  }

  var queryParams = util._extend({model: 'en-US_BroadbandModel'}, pick(options, QUERY_PARAMS_ALLOWED));
  var queryString = Object.keys(queryParams).map(function (key) {
    return key + '=' + (key == 'watson-token' ? queryParams[key] : encodeURIComponent(queryParams[key])); // the server chokes if the token is correctly url-encoded
  }).join('&');

  var url = (options.url || "wss://stream.watsonplatform.net/speech-to-text/api").replace(/^http/, 'ws') + '/v1/recognize?' + queryString;

  // turn off all the extras if we're just outputting a string with a single final result
  var defaults = {
    interim_results: false,
    word_confidence: false,
    timestamps: false,
    max_alternatives: 1
  };

  // but turn everything on if we're in objectMode and the end user can consume it
  var objectModeDefaults = {
    interim_results: true,
    word_confidence: true,
    timestamps: true,
    max_alternatives: 3
  };

  var openingMessage = util._extend({
    action: 'start',
    'content-type': 'audio/wav',
    continuous: true,
    max_alternatives: 3,
    inactivity_timeout: 30
  },
    options.objectMode ? objectModeDefaults : defaults,
    pick(options, OPENING_MESSAGE_PARAMS_ALLOWED)
  );


  var self = this;

  //node params: requestUrl, protocols, origin, headers, extraRequestOptions
  // browser params: requestUrl, protocols (all others ignored)
  var socket = this.socket = new W3CWebSocket(url, null, null, options.headers, null);

  // when the input stops, let the service know that we're done
  self.on('finish', self.finish.bind(self));

  socket.onerror = function (error) {
    self.listening = false;
    self.emit('error', error);
  };


  this.socket.onopen = function () {
    self.sendJSON(openingMessage);
    self.emit('connect');
  };

  this.socket.onclose = function (e) {
    if (self.listening) {
      self.listening = false;
      self.push(null);
    }
    /**
     * @event RecognizeStream#connection-close
     * @param {Number} reasonCode
     * @param {String} description
     */
    self.emit('close', e.code, e.reason);
  };

  /**
   * @event RecognizeStream#error
   */
  function emitError(msg, frame, err) {
    if (err) {
      err.message = msg + ' ' + err.message;
    } else {
      err = new Error(msg);
    }
    err.raw = frame;
    self.emit('error', err);
  }

  socket.onmessage = function (frame) {
    if (typeof frame.data !== 'string') {
      return emitError('Unexpected binary data received from server', frame);
    }

    var data;
    try {
      data = JSON.parse(frame.data);
    } catch (jsonEx) {
      return emitError('Invalid JSON received from service:', frame, jsonEx);
    }

    self.emit('message', data);

    if (data.error) {
      emitError(data.error, frame);
    } else if (data.state === 'listening') {
      // this is emitted both when the server is ready for audio, and after we send the close message to indicate that it's done processing
      if (!self.listening) {
        self.listening = true;
        self.emit('listening');
      } else {
        self.listening = false;
        self.push(null);
        socket.close();
      }
    } else if (data.results) {
      /**
       * Object with interim or final results, including possible alternatives. May have no results at all for empty audio files.
       * @event RecognizeStream#results
       * @param {Object} results
       * @deprecated - use objectMode instead
       */
      self.emit('results', data.results);

      // note: currently there is always either 0 or 1 entries in the results array. However, this may change in the future.
      data.results.forEach(function (result) {
        /**
         * Object with interim or final results, including possible alternatives. May have no results at all for empty audio files.
         * @event RecognizeStream#results
         * @param {Object} results
         * @deprecated - use objectMode instead
         */
        result.index = data.result_index;
        self.emit('result', result);
        if (result.final && result.alternatives) {
          /**
           * Finalized text
           * @event RecognizeStream#data
           * @param {String} transcript
           */
          if (options.objectMode) {
            self.push(result);
          } else {
            self.push(result.alternatives[0].transcript, 'utf8');
          }

        }
      });
    } else {
      emitError('Unrecognised message from server', frame);
    }
  };

  //this.messages = [];
  //var send = socket.send;
  //socket.send = function(msg) {
  //  self.messages.push(msg);
  //  return send.apply(socket, arguments);
  //};

  this.initialized = true;
};

RecognizeStream.prototype.sendJSON = function sendJSON(msg) {
  this.emit('send-json', msg);
  return this.socket.send(JSON.stringify(msg));
};

RecognizeStream.prototype.sendData = function sendData(data) {
  this.emit('send-data', data);
  return this.socket.send(data);
};

RecognizeStream.prototype._read = function (size) {
  // there's no easy way to control reads from the underlying library
  // so, the best we can do here is a no-op
};

RecognizeStream.prototype._write = function (chunk, encoding, callback) {
  var self = this;
  if (self.finished) {
    // can't send any more data after the stop message (although this shouldn't happen normally...)
    return;
  }
  if (self.listening) {
    self.sendData(chunk);
    this.afterSend(callback);
  } else {
    if (!this.initialized) {
      if (!this.options['content-type']) {
        this.options['content-type'] = RecognizeStream.getContentType(chunk);
      }
      this.initialize();
    }
    this.once('listening', function () {
      self.sendData(chunk);
      this.afterSend(callback);
    });
  }
};

// flow control - don't ask for more data until we've finished what we have
// todo: see if this can be improved
RecognizeStream.prototype.afterSend = function afterSend(next) {
  if (this.socket.bufferedAmount <= this._writableState.highWaterMark || 0) {
    next();
  } else {
    setTimeout(this.afterSend.bind(this, next), 10);
  }
};

RecognizeStream.prototype.stop = function () {
  this.emit('stop');
  this.finish();
};

RecognizeStream.prototype.finish = function finish() {
  // this is called both when the source stream finishes, and when .stop() is fired, but we only want to send the stop message once.
  if (this.finished) {
    return;
  }
  this.finished = true;
  var self = this;
  var closingMessage = {action: 'stop'};
  if (self.socket) {
    self.sendJSON(closingMessage);
  } else {
    this.once('connect', function () {
      self.sendJSON(closingMessage);
    });
  }
};

RecognizeStream.prototype.promise = require('./promise');


RecognizeStream.getContentType = function (buffer) {
  return contentType(buffer.slice(0, 4).toString());
};


module.exports = RecognizeStream;
