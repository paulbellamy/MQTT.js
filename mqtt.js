/* Copyright (c) 2011 Adam Rudd. See LICENSE for more information */

var sys = require("sys");
var net = require("net");
var inspect = require("util").inspect;
var EventEmitter = require("events").EventEmitter;

var packet = require("./packet");

/* Major TODO:
 * 1. Insert error checking code around clientID/topic name slices.
 *    These are notorious for crashing the program if the length is too long
 * 2. Addendum to 1: Overhaul the packet checking stuff. We need a more
 *    standard method of handling it rather than just throwing if too long
 *    then don't slice around every slice call.
 * 3. Make client.packet a proper object (i.e. with a constructor and
 *    well specified)
 * 4. Standardise error emits rather than just putting out arbitrary strings.
 *    It makes doing sane error recovery a little difficult.
 * 5. Tidy up client.process. There is a lot of stuff that could be shared
 *    between packet types.
 * 6. Break client.accumulate (and client.process)
 *    into a bunch of subroutines for
 *    easier unit testing
 * 7. Do up some manner of testing framework.
 *    (but the lifeboats make the deck look crowded!)
 * 8. Standardise packet construction i.e. make functions that
 *    return packets rather than generating them in client.sendPacket
 */

function MQTTClient(socket) {
    this.clientID = '';
    this.socket = socket;
    this.buffer = new Buffer(0);
    this.subscriptions = [];
    this.packet = undefined;

    var self = this;

    this.socket.on('data', function(data) {
      self.accumulate(data);
    });

    this.on('packet_received', function(packet) {
      self.process(packet);
    });

    /* TODO: consider catching the socket timeout event */

    this.socket.on('error', function(exception) {
      self.emit('error', exception);
    });

    /* Arguably this is an error if it doesn't come
     * after a disconnect packet */
    this.socket.on('close', function(had_error) {
	self.emit('close');
    });
}

sys.inherits(MQTTClient, EventEmitter);

MQTTClient.prototype.accumulate = function(data) {
  var self = this;
  if (!self.packet) {
    self.packet = new MQTTPacket();
    self.packet.on('end', function(packet) {
      self.process(packet);
    });
  }

  self.packet.write(data);
};


MQTTClient.prototype.process = function(packet) {
  switch(packet.headers.command) {
	case MQTTPacketType.Connect:
	    var count = 0;

	    /* TODO: what would be interesting would be to change this based on what
	     * variant of MQTT we're implementing. MQIsdp is just the original
	     * hierachical version, but we could have all kinds of different breeds!
	     */
	    var version = "\00\06MQIsdp\03";
	    if(packet.body.slice(count, count+version.length).toString('utf8') !== version) {
		sys.log('Invalid version');
		this.emit('error', 'Invalid version string');
	    }

	    /* Skip the version field */
	    count += version.length;

	    /* Extract the connect header */
	    packet.willRetain = (packet.body[count] & 0x20 != 0);
	    packet.willQos = (packet.body[count] & 0x18) >> 3;
	    packet.willFlag = (packet.body[count] & 0x04 != 0);
	    packet.cleanStart = (packet.body[count] & 0x02 != 0);
	    // TODO: add some error detection here e.g. qos = 1 when flag = false isn't allowed
	    // Maybe. This is, after all, a protocol library, not an actual usage library
	    count++;

	    /* Extract the keepalive */
	    packet.keepalive = packet.body[count++] << 8;
	    packet.keepalive += packet.body[count++];

	    /* Extract the client ID length */
	    var clientLen = packet.body[count++] * 256;
	    clientLen += packet.body[count++];
	    
	    /* Is our client ID length reasonable? */
	    if(clientLen > packet.body.length) {
		/* Just in case our client ID length is too long */
		/* TODO: make some proper error objects or messages */
		/* TODO: and handle this better rather than just dropping everything */
		this.emit('error', "Protocol error - client ID length");
		return;
	    }

	    /* Yep, extract the client ID */
	    packet.clientId = packet.body.slice(count, count+clientLen).toString('utf8');
	    count += clientLen + 2;

	    /* Extract the will topic/message */
	    if(packet.willFlag) {
		/* Calculate the length of the topic string */
		var topicLen = packet.body[count++] << 8;
		topicLen += packet.body[count++];
		/* Cut the topic string out of the buffer */
		packet.willTopic = packet.body.slice(count, count+topicLen).toString('utf8');
		/* Move the pointer to after the topic string */
		count += topicLen;

		/* What remains in the body is will message */
		packet.willMessage = packet.body.slice(count, packet.body.length);
	    }

	    /* Clear the body as to not confuse the guy on the other end */
	    delete packet.body;

	    this.emit('connect', packet);
	    break;
	case MQTTPacketType.Connack:
	    break;
	case MQTTPacketType.Publish:
	    var count = 0;
	    /* Extract the topic name */
	    var topicLen = packet.body[count++] * 256;
	    topicLen += packet.body[count++];

	    packet.topic = packet.body.slice(count, count+topicLen).toString('utf8');
	    count += topicLen;

	    /* Extract the message ID if appropriate (i.e. if QoS > 0) */
	    if(packet.qos > 0) {
		var messageId = packet.body[count++] << 8;
		messageId += packet.body[count++];
		
		packet.messageId = messageId;
	    }

	    /* Whatever remains is the payload */
	    packet.payload = packet.body.slice(count, packet.body.length).toString('utf8');

	    delete packet.body;

	    this.emit('publish', packet);
	    break;
	case MQTTPacketType.Puback:
	    break;
	case MQTTPacketType.Pubrec:
	    break;
	case MQTTPacketType.Pubrel:
	    var count = 0;
	    /* Extract the message ID */
	    var messageId = packet.body[count++] << 8;
	    messageId += packet.body[count++];
	    packet.messageId = messageId;

	    delete packet.body;
	    this.emit('pubrel', packet);
	    break;
	case MQTTPacketType.Pubcomp:
	    break;
	case MQTTPacketType.Subscribe:
	    var count = 0;
	    /* Extract the message ID */
	    var messageId = packet.body[count++] << 8;
	    messageId += packet.body[count++];
	    packet.messageId = messageId;

	    var subscriptions = [];
	    while(count < packet.body.length) {
		var tq = {};

		/* Extract the topic name */
		var topicLen = packet.body[count++] << 8;
		topicLen += packet.body[count++];

		tq.topic = packet.body.slice(count, count+topicLen).toString('utf8');
		count += topicLen;

		/* Get the QoS of the subscription */
		tq.qos = packet.body[count++];

		/* Push topic/qos to the list of subscriptions */
		subscriptions.push(tq);
	    }

	    packet.subscriptions = subscriptions;

	    delete packet.body;
	    this.emit('subscribe', packet);
	    break;
	case MQTTPacketType.Suback:
	    break;
	case MQTTPacketType.Unsubscribe:
	    var count = 0;
	    /* Extract the message ID */
	    var messageId = packet.body[count++] << 8;
	    messageId += packet.body[count++];
	    packet.messageId = messageId;

	    var unsubscriptions = [];
	    for(var i = count; i < packet.length; i++) {
		var t = {};

		/* Extract the topic name */
		var topicLen = packet.body[count++] << 8;
		topicLen += packet.body[count++];

		t.topic = packet.body.slice(count, count+topicLen).toString('utf8');
		count += topicLen + 2;

		/* Push topic/qos to the list of subscriptions */
		unsubscriptions.push(t);
	    }

	    packet.unsubscriptions = unsubscriptions;

	    delete packet.body;
	    this.emit('unsubscribe', packet);
	    break;
	case MQTTPacketType.Unsuback:
	    break;
	case MQTTPacketType.Pingreq:
	    this.emit('pingreq', packet); 
	    break;
	case MQTTPacketType.Pingresp:
	    break;
	case MQTTPacketType.Disconnect:
	    this.emit('disconnect', packet);
	    break;
	default:
	    this.emit('error', "Invalid packet type");
	    sys.log("Invalid packet type");
    }
}

MQTTClient.prototype.connack = function(rc) {
    sys.log('Connacking');
    var pkt = [MQTTPacketType.Connack<<4, 2, 0, rc];
    var b = new Buffer(pkt);

    sys.log("Connack packet " + inspect(b));

    this.socket.write(b);
}

MQTTClient.prototype.suback = function(messageId, qos) {
    sys.log('Subacking');
    var pkt = [MQTTPacketType.Suback<<4];
    /* Message id + length of qos array */
    var pktLen = 2 + qos.length;

    /* Calculate the packet length and push it to the packet */
    do {
	var digit = pktLen % 128
	pktLen = parseInt(pktLen / 128);
	if(pktLen > 0) {
	    digit = digit | 0x80;
	}
	pkt.push(digit);
    } while(pktLen > 0);

    /* Push the  message ID to the packet */
    pkt.push(messageId >> 8);
    pkt.push(messageId & 0xFF);

    /* Push the granted QoS levels to the packet */
    for(var i = 0; i < qos.length; i++) {
	pkt.push(qos[i]);
    }
    sys.log("Suback packet " + inspect(new Buffer(pkt)));

    this.socket.write(new Buffer(pkt));
}

MQTTClient.prototype.publish = function(topic, payload) {
    // TODO: this probably only supports QoS 0
    sys.log('Publishing topic: ' + topic + ' payload: ' + payload);

    var pkt = [MQTTPacketType.Publish << 4];
    /* Length of the topic + length of the length of the topic (2) + the length of the payload */
    var pktLen = topic.length + 2 + payload.length;

    /* Calculate the packet length and push it to the packet */
    do {
	var digit = pktLen % 128
	pktLen = parseInt(pktLen / 128);
	if(pktLen > 0) {
	    digit = digit | 0x80;
	}
	pkt.push(digit);
    } while(pktLen > 0);

    /* Push the topic length to the packet */
    pkt.push(topic.length >> 8);
    pkt.push(topic.length & 0xFF);

    /* Push the topic to the packet */
    for(var i = 0; i < topic.length; i++) {
	pkt.push(topic.charCodeAt(i));
    }

    /* Push the payload to the packet */
    for(var i = 0; i < payload.length; i++) {
	pkt.push(payload.charCodeAt(i));
    }

    sys.log("Publishing packet " + inspect(new Buffer(pkt)));

    /* Send the packet */
    this.socket.write(new Buffer(pkt));
}

MQTTClient.prototype.pingresp = function() {
    sys.log('Pinging');

    var pkt = [MQTTPacketType.Pingresp << 4, 0];
    sys.log('Ping packet: ' + inspect(new Buffer(pkt)));

    this.socket.write(new Buffer(pkt));
}

function MQTTServer() {
    this.server = net.createServer();
    var self = this;
    this.server.on('connection', function(socket) {
	sys.log("Connection from " + socket.remoteAddress);

	client = new MQTTClient(socket);

	self.emit('new_client', client);
    });
}

sys.inherits(MQTTServer, EventEmitter);
var exports = module.exports;
exports.MQTTServer = MQTTServer;
