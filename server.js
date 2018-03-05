/* jshint esversion:6 */
let fs = require('fs');
let WebSocket = require('ws');
let crypto = require('crypto');

function loadJSON(filename) {
	try {
		let data = fs.readFileSync(filename, 'utf8');
		console.log("Loaded JSON '" + filename + "'");
		return JSON.parse(data);
	} catch (e) {
		console.warn(e);
		return null;
	}
}

let Server = {
	configFilename: "JSON/config.json",

	/** Sends data to all clients
	channel: if not null, restricts broadcast to clients in the channel
	*/
	broadcast: function (data, channel) {
		for (let client of Server.websocket.clients) {
			if (channel ? client.channel === channel : client.channel) {
				send(data, client);
			}
		}
	},

	hash: function (password) {
		let sha = crypto.createHash('sha256');
		sha.update(password + Server.Config.salt);
		return sha.digest('base64').substr(0, 6);
	},

	send: function (data, client) {
		// Add timestamp to command
		data.time = Date.now();
		try {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify(data));
			}
		} catch (e) {
			console.error(e);
		}
	},

	getAddress: function (client) {
		if (Server.Config.x_forwarded_for) {
			// The remoteAddress is 127.0.0.1 since if all connections
			// originate from a proxy (e.g. nginx).
			// You must write the x-forwarded-for header to determine the
			// client's real IP address.
			return client.upgradeReq.headers['x-forwarded-for'];
		}
		else {
			return client.upgradeReq.connection.remoteAddress;
		}
	},

	nicknameValid: function (nick) {
		// Allow letters, numbers, and underscores
		return /^[a-zA-Z0-9_]{1,24}$/.test(nick);
	},

	isAdmin: function (client) {
		return client.nick === Server.Config.admin;
	},

	isMod: function (client) {
		if (Server.isAdmin(client)) return true;
		if (Server.Config.mods) {
			if (client.trip && Server.Config.mods.includes(client.trip)) {
				return true;
			}
		}
		return false;
	}
};
// Declaring global variables for simplicity
let send = Server.send;

// Config
Server.Config = loadJSON(Server.configFilename);
fs.watchFile(Server.configFilename, { persistent: false }, _ => Server.Config = loadJSON(Server.configFilename));

// WebSocket Server
Server.websocket = new WebSocket.Server({ host: Server.Config.host, port: Server.Config.port });
console.log("Started server on " + Server.Config.host + ":" + Server.Config.port);

Server.websocket.on('connection', socket => {
	// Socket receiver has crashed, flush and kill socket
	socket._receiver.onerror = error => {
		socket._receiver.flush();
		socket._receiver.messageBuffer = [];
		socket._receiver.cleanup();
		socket.close();
	};

	socket.on('message', data => {
		try {
			// Don't penalize yet, but check whether IP is rate-limited
			if (POLICE.frisk(Server.getAddress(socket), 0)) {
				send({ cmd: 'warn', text: "Your IP is being rate-limited or blocked." }, socket);
				return;
			}

			// ignore ridiculously large packets
			if (data.length > 65536) {
				return;
			}
			let args = JSON.parse(data);
			let cmd = args.cmd;

			if (COMMANDS.hasOwnProperty(cmd)) {
				let command = COMMANDS[cmd];
				if (command instanceof Command && args) {
					command.run(socket, args);
				}
			}
		} catch (error) {
			// Socket sent malformed JSON or buffer contains invalid JSON
			// For security reasons, we should kill it
			socket._receiver.flush();
			socket._receiver.messageBuffer = [];
			socket._receiver.cleanup();
			socket.close();
			console.warn(error.stack);
		}
	});

	socket.on('close', _ => {
		try {
			if (socket.channel) {
				Server.broadcast({ cmd: 'onlineRemove', nick: socket.nick }, socket.channel);
			}
		} catch (error) {
			console.warn(error.stack);
		}
	});
});

function getValue (value, ...params) { // returns the value, if it's a function it will be ran with the params
	if (typeof(value) === 'function') {
		return value(...params);
	}
	return value;
}

class Command {
	constructor (verify, func) {
		this.func = func;
		this.verify = verify || (_ => true);

		this.settings = {
			penalize: 1,
			onPenalized: "You are doing stuff too much! Wait a bit!"
		};
	}

	run (socket, args) {
		if (POLICE.frisk(Server.getAddress(socket), this.getPenalize(socket, args))) {
			return this.getOnPenalized(socket, args);
		}
		if (this.verify(socket, args)) {
			return this.func(socket, args);
		}
		return false;
	}

	getPenalize (socket, args) {
		return getValue(this.settings.penalize, socket, args);
	}

	getOnPenalized (socket, args) {
		return getValue(this.settings.onPenalized, socket, args);
	}

	setCommandFunction (func) { // for if they want to set the command later
		this.func = func;
		return this;
	}

	setPenalize (n=1) {
		this.settings.penalize = n;
		return this;
	}

	setOnPenalized (message="You are doing stuff too much! Wait a bit!") {
		if (typeof(message) === 'string') {
			this.settings.onPenalized = (socket, args) => send({ cmd: 'warn', text: message }, socket);
		} else if (typeof(message) === 'function') {
			this.settings.onPenalized = message;
		}
		return this;
	}
}


let COMMANDS = Server.COMMANDS = {
	ping: new Command(null, _ => _), // Don't do anything
	join: new Command((socket, args) => args.channel && args.nick && !socket.nick, (socket, args) => {
		let channel = String(args.channel);
		let nick = String(args.nick);

		// Process channel name
		channel = channel.trim();
		if (!channel) {
			// Must join a non-blank channel
			return;
		}

		// Process nickname
		let nickArr = nick.split('#', 2);
		nick = nickArr[0].trim();

		if (!Server.nicknameValid(nick)) {
			send({ cmd: 'warn', text: "Nickname must consist of up to 24 letters, numbers, and underscores" }, socket);
			return;
		}

		let password = nickArr[1];
		if (nick.toLowerCase() == Server.Config.admin.toLowerCase()) {
			if (password !== Server.Config.password) {
				send({ cmd: 'warn', text: "Cannot impersonate the admin" }, socket);
				return;
			}
		} else if (password) {
			socket.trip = Server.hash(password);
		}

		let address = Server.getAddress(socket);
		for (let client of Server.websocket.clients) {
			if (client.channel === channel) {
				if (client.nick.toLowerCase() === nick.toLowerCase()) {
					send({ cmd: 'warn', text: "Nickname taken" }, socket);
					return;
				}
			}
		}

		// Announce the new user
		Server.broadcast({ cmd: 'onlineAdd', nick }, channel);

		// Formally join channel
		socket.channel = channel;
		socket.nick = nick;

		// Set the online users for new user
		let nicks = [];
		for (let client of Server.websocket.clients) {
			if (client.channel === channel) {
				nicks.push(client.nick);
			}
		}
		send({ cmd: 'onlineSet', nicks }, socket);
	}).setPenalize(3).setOnPenalized("You are joining channels too fast. Wait a moment and try again."),

	chat: new Command((socket, args) => socket.channel && socket.nick && args.text, (socket, args) => {
		let text = args.modifiedText; // modified in the setPenalize.

		let data = { cmd: 'chat', nick: socket.nick, text };
		if (Server.isAdmin(socket)) {
			data.admin = true;
		} else if (Server.isMod(socket)) {
			data.mod = true;
		}
		
		if (socket.trip) {
			data.trip = socket.trip;
		}

		Server.broadcast(data, socket.channel);
	}).setPenalize((socket, args) => {
		args.modifiedText = String(args.text)
			.replace(/^\s*\n|^\s+$|\n\s*$/g, '') // strip newlines from beginning and end
			.replace(/\n{3,}/g, "\n\n"); // replace 3+ newlines with just 2 newlines
		return (args.modifiedText.length / 83 / 4) + 1;
	}).setOnPenalized("You are sending too much text. Wait a moment and try again.\nPress the up arrow key to restore your last message."),

	invite: new Command((socket, args) => socket.channel && socket.nick && args.nick, (socket, args) => {
		let nick = String(args.nick);

		let friend;
		for (let client of Server.websocket.clients) {
			// Find friend's client
			if (client.channel == socket.channel && client.nick == nick) {
				friend = client;
				break;
			}
		}
		if (!friend) {
			send({ cmd: 'warn', text: "Could not find user in channel" }, socket);
			return;
		}

		if (friend === socket) {
			// Ignore silently
			return;
		}

		let channel = Math.random().toString(36).substr(2, 8);
		send({ cmd: 'info', text: "You invited " + friend.nick + " to ?" + channel }, socket);
		send({ cmd: 'info', text: socket.nick + " invited you to ?" + channel }, friend);
	}).setPenalize(2).setOnPenalized("You are sending invites too fast. Wait a moment before trying again."),

	stats: new Command(null, (socket, args) => {
		let ips = {};
		let channels = {};

		for (let client of Server.websocket.clients) {
			if (client.channel) {
				channels[client.channel] = true;
				ips[Server.getAddress(client)] = true;
			}
		}

		send({ cmd: 'info', text: Object.keys(ips).length + " unique IPs in " + Object.keys(channels).length + " channels" }, socket);
	}),

	// Moderator-only commands below this point

	ban: new Command((socket, args) => Server.isMod(socket) && socket.channel && socket.nick && args.nick, (socket, args) => {
		let nick = String(args.nick);

		let badClient = Server.websocket.clients
			.filter(client =>  client.channel === socket.channel && client.nick === nick, socket)[0];

		if (!badClient) {
			send({ cmd: 'warn', text: "Could not find " + nick }, socket);
			return;
		}

		if (Server.isMod(badClient)) {
			send({ cmd: 'warn', text: "Cannot ban moderator" }, socket);
			return;
		}

		POLICE.arrest(Server.getAddress(badClient));
		console.log(socket.nick + " [" + socket.trip + "] banned " + nick + " in " + socket.channel);
		Server.broadcast({ cmd: 'info', text: "Banned " + nick }, socket.channel);
	}).setPenalize(0.1), // very minute amount on the ban

	unban: new Command((socket, args) => Server.isMod(socket) && socket.channel && socket.nick && args.ip, (socket, args) => {
		let ip = String(args.ip);

		POLICE.pardon(ip);
		console.log(socket.nick + " [" + socket.trip + "] unbanned " + ip + " in " + socket.channel);
		send({ cmd: 'info', text: "Unbanned " + ip }, socket);
	}),

	// Admin-only commands below this point

	listUsers: new Command(Server.isAdmin, socket => {
		let channels = {};
		for (let client of Server.websocket.clients) {
			if (client.channel) {
				if (!channels[client.channel]) {
					channels[client.channel] = [];
				}
				channels[client.channel].push(client.nick);
			}
		}

		let lines = Object.entries(channels).map(channel => "?" + channel[0] + " " + channel[1].join(', '));
		let text = Server.websocket.clients.length + " users online:\n\n";
		text += lines.join("\n");
		send({ cmd: 'info', text }, socket);
	}),

	broadcast: new Command((socket, args) => args.text && Server.isAdmin(socket), (socket, args) => {
		let text = String(args.text);
		Server.broadcast({ cmd: 'info', text: "Server broadcast: " + text });
	})
};


// rate limiter
let POLICE = Server.POLICE = {
	records: {},
	halflife: 30000, // ms
	threshold: 15,

	loadJail: filename => {
		let ids;
		try {
			let text = fs.readFileSync(filename, 'utf8');
			ids = text.split(/\r?\n/);
		} catch (e) {
			return; // don't need console.error, because the file is only created if you want tob an users even after restart
		}

		for (let id of ids) {
			if (id && id[0] != '#') {
				POLICE.arrest(id);
			}
		}
		console.log("Loaded jail '" + filename + "'");
	},

	search: id => {
		let record = POLICE.records[id];
		if (!record) {
			record = POLICE.records[id] = {
				time: Date.now(),
				score: 0,
			};
		}
		return record;
	},

	frisk: (id, deltaScore) => {
		let record = POLICE.search(id);
		if (record.arrested) {
			return true;
		}

		record.score *= Math.pow(2, -(Date.now() - record.time) / POLICE.halflife);
		record.score += deltaScore;
		record.time = Date.now();
		if (record.score >= POLICE.threshold) {
			return true;
		}
		return false;
	},

	arrest: id => {
		let record = POLICE.search(id);
		if (record) {
			record.arrested = true;
		}
	},

	pardon: id => {
		let record = POLICE.search(id);
		if (record) {
			record.arrested = false;
		}
	}
};

POLICE.loadJail('jail.txt');
