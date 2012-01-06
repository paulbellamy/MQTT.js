var sys = require("util");
var net = require("net");
var inspect = require("util").inspect;
var EventEmitter = require("events").EventEmitter;

MQTTPacketType = {'Connect':1, 'Connack':2, 
		  'Publish':3, 'Puback':4, 'Pubrec':5, 'Pubrel':6, 'Pubcomp':7, 
		  'Subscribe':8, 'Suback':9, 'Unsubscribe':10, 'Unsuback':11,
		  'Pingreq':12, 'Pingresp':13,
		  'Disconnect':14};

// Handles generation and parsing of MQTT Packets
// Essentially it is a parser for one MQTT Packet
// Responds to Node's writeable stream methods, so
// data can be streamed to it, and fires 'end'
// when packet is complete.
//
// options:
//  timeout - boolean, when to timeout (default is never)
//
// events:
//  'drain' - Fires when finished parsing current chunk (yields nothing)
//  'error' - There was an error processing the packet  (yields an explanation string)
//  'end'   - Packet has finished parsing successfully  (yields the packet)
function MQTTPacket(options) {
  var self = this;

  self.buffer = new Buffer(0);
  self.writable = true; // becomes false when parsing is done

  self.headers = {};
  self.body_length = 0
  self.body = undefined;

  if (options) {
    self.options = options
  } else {
    self.options = {}
  }

  return self;
}

MQTTPacket.prototype.write = function(data) {
  var self = this;

  // Cannot write data to an unwritable packet
  // It has already finished, errored, or etc...
  if (self.writable == false) {
    self.emit('error', "Writing to closed packet");
    return false;
  }

	/* Throw away the packet after, options.timeout ms */
	/* Consider emitting an error here, this suggests that
	 * the client is either defective or is having 
	 * network troubles of some kind.
   * Start the timeout from the first time we receive data.
	 */
  if (self.options.timeout && !self.timeout) {
    self.timeout = setTimeout(function(client) {
        sys.log('Discarding incomplete packet');
        self.close();
        self.emit('error', "Discarding incomplete packet");
    }, +self.options.timeout, self);
  }


  /* Add the incoming data to the self's data buffer */
  var newSize = self.buffer.length + data.length;
  var newBuf = new Buffer(newSize);
  self.buffer.copy(newBuf);
  data.copy(newBuf, self.buffer.length);
  self.buffer = newBuf;

  sys.log("Adding data to buffer:\n" + inspect(self.buffer));

  return self.flush();
};

MQTTPacket.prototype.close = function() {
  var self = this;

  self.writable = false;
  self.emit('end', self);
};

// Attempt to parse and drain the incoming buffers
MQTTPacket.prototype.flush = function() {
  var self = this;

  /* Process all the data in the buffer */
  while(self.buffer.length) {
      /* Fill out the header fields */
      if(self.headers === undefined) {
        self.headers = {
          command : (self.buffer[0] & 0xF0) >> 4,
          dup : ((self.buffer[0] & 0x08) == 0x08),
          qos : (self.buffer[0] & 0x06) >> 2,
          retain : ((self.buffer[0] & 0x01) != 0)
        };

        sys.log("Packet info: " + inspect(self.headers));
      }

      /* See if we have enough data for the header and the
       * shortest possible remaining length field
       */
      if(self.buffer.length < 2) {
        /* Haven't got enough data for a new packet */
        /* Wait for more */
        sys.log("Incomplete packet received, waiting for more data");
        break;
      }

      /* Calculate the length of the packet */
      var length = 0;
      var mul = 1;
      var gotAll = false;


      /* TODO: move calculating the length into a utility function */
      for(var i = 1; i < self.buffer.length; i++) {
        length += (self.buffer[i] & 0x7F) * mul;
        mul *= 0x80;

        if(i > 5) {
          /* Length field too long */
          sys.log("Error: length field too long");
          self.emit('error', "Length field too long");
          return false;
        }

        /* Reached the last length byte */
        if(!(self.buffer[i] & 0x80)) {
          gotAll = true;
          break;
        }
      }

      /* Haven't got the whole of the length field yet, wait for more data */
      if(!gotAll) {
        sys.log("Incomplete length field");
        break;
      }

      /* The size of the header + the size of the remaining length
       * + the length of the body of the packet */
      self.length = 1 + i + length;
      self.lengthLength = i;
      sys.log("Length calculated: " + self.length);
  }

  /* Ok, we have enough data to get the length of the packet
   * Now see if we have all the data to complete the packet
   */
  if(self.buffer.length >= self.length) {
    /* Cut the current packet out of the buffer */
    var chunk = self.buffer.slice(0, self.length);

    /* Do something with it */
    sys.log("Packet complete\n" + inspect(chunk));
    /* Cut the body of the packet out of the buffer */
    self.body = chunk.slice((self.lengthLength + 1), chunk.length);

    /* Cut the lengthLength field out of the packet, we don't need it anymore */
    delete self.lengthLength;

    self.emit('end', self);

    /* We've got a complete packet, stop the incomplete packet timer */
    if (self.timeout) {
      clearTimeout(self.timeout);
    }
  } else {
    /* Haven't got the whole packet yet, wait for more data */
    sys.log("Incomplete packet, bytes needed to complete: " + (self.packet.length - self.buffer.length));
    return false;
  }

  return true;
};

module.exports.MQTTPacket = MQTTPacket;
