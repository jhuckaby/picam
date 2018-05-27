#!/usr/bin/env node

// Simple Raspberry Pi Image Server
// Uploads daily images with retry and auto-recovery
// Web server for real-time snapshots in browser
// Copyright (c) 2018 Joseph Huckaby, MIT License

var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var util = require('util');
var Path = require('path');
var http = require('http');

process.chdir( __dirname );

var WebServer = {
	
	debug: false,
	
	version: "1.0",
	conns: null,
	nextConnId: 1,
	config: require('./config.json'),
	
	startup: function() {
		// begin the things
		var self = this;
		var argv = process.argv.slice(2);
		this.debug = !!(argv.indexOf('debug') > -1);
		
		// fork daemon process unless in debug mode
		if (!this.debug && !process.env.__daemon) {
			process.env.__daemon = 1;
			var opts = {
				stdio: ['ignore', 'ignore', 'ignore'],
				env: process.env,
				cwd: __dirname,
				detached: true
			};
			var child = cp.spawn(process.execPath, [__filename].concat(argv), opts);
			child.unref();
			process.exit(0);
		}
		
		// write pid file
		fs.writeFileSync( 'pid.txt', process.pid );
		
		this.logDebug(2, "WebServer v" + this.version + " Starting Up");
		
		// listen for shutdown events
		process.on('SIGINT', function() { 
			self.logDebug(2, "Caught SIGINT");
			self.shutdown(); 
		} );
		process.on('SIGTERM', function() { 
			self.logDebug(2, "Caught SIGTERM");
			self.shutdown(); 
		} );
		
		// start tick timer for periodic tasks
		this.lastTickDate = this.getDateArgs( new Date() );
		this.tickTimer = setInterval( this.tick.bind(this), 1000 );
		
		this.startWebServer();
	},
	
	startWebServer: function() {
		// start http socket listener for stats requests / health checks
		var self = this;
		this.conns = {};
		this.numConns = 0;
		
		this.logDebug(2, "Starting HTTP server on port: " + this.config.webServerPort);
		
		this.http = http.createServer( function(request, response) {
			self.parseHTTPRequest( request, response );
		} );
		
		this.http.on('connection', function(socket) {
			// new socket
			var ip = socket.remoteAddress || '';
			var id = self.nextConnId++;
			self.conns[ id ] = socket;
			self.numConns++;
			self.logDebug(8, "New incoming HTTP connection: " + id, { ip: ip, num_conns: self.numConns });
			
			// Disable the Nagle algorithm.
			socket.setNoDelay( true );
			
			socket.on('error', function(err) {
				// client aborted connection?
				self.logDebug(3, "Socket error: " + id + ": " + err, { ip: ip });
			} );
			
			socket.on('close', function() {
				// socket has closed
				self.logDebug(8, "HTTP connection has closed: " + id, { ip: ip });
				delete self.conns[ id ];
				self.numConns--;
			} );
		} ); // new connection
		
		this.http.listen( this.config.webServerPort, function(err) {
			self.logDebug(3, "Web server is ready");
		} );
	},
	
	parseHTTPRequest: function(request, response) {
		// handle raw http request
		var self = this;
		this.logDebug(8, "New HTTP request: " + request.method + " " + request.url);
		this.logDebug(9, "Incoming HTTP Headers:", request.headers);
		
		var args = {
			request: request,
			response: response
		};
		
		if (request.url.match(/^\/snapshot/)) {
			// take single snapshot, return binary image (don't upload)
			this.handleSnapshot(args);
		}
		else if (request.url.match(/^\/run/)) {
			// run scheduled job (usually runs auto at midnight)
			this.snapshotUpload();
			this.sendHTTPResponse(args, 
				"200 OK", 
				{ 'Content-Type': "text/html" }, 
				"Running daily snapshot / upload in background.\n"
			);
		}
		else if (request.url.match(/^\/upload/)) {
			// run daily upload job
			this.uploadAllFiles();
			this.sendHTTPResponse(args, 
				"200 OK", 
				{ 'Content-Type': "text/html" }, 
				"Running daily upload in background.\n"
			);
		}
		else if (request.url.match(/^\/delete/)) {
			// run daily delete job
			this.deleteOldFiles();
			this.sendHTTPResponse(args, 
				"200 OK", 
				{ 'Content-Type': "text/html" }, 
				"Running daily maintenance (delete) in background.\n"
			);
		}
		else {
			this.logDebug(3, "HTTP 404 Not Found: " + request.url);
			this.sendHTTPResponse(args, "404 Not Found");
		}
	},
	
	sendHTTPResponse: function(args, status, headers, body) {
		// send custom HTTP response
		var self = this;
		var request = args.request;
		var response = args.response;
		
		// parse code and status
		var http_code = 200;
		var http_status = "OK";
		if (status && status.match(/^(\d+)\s+(.+)$/)) {
			http_code = parseInt( RegExp.$1 );
			http_status = RegExp.$2;
		}
		
		this.logDebug(9, "Sending Response: HTTP " + http_code + " " + http_status, headers);
		
		if (!headers) headers = {};
		if (!headers['Cache-Control']) headers['Cache-Control'] = 'private, no-cache, no-store';
		
		args.response.writeHead( http_code, http_status, headers || {} );
		if (body) args.response.write( body );
		args.response.end();
	},
	
	getSnapshotCommand: function() {
		// construct command to raspistill
		// e.g. /usr/bin/raspistill -rot 90 -w 1920 -q 90
		var cmd = this.config.snapshotCommand;
		if (this.config.snapshotOpts) cmd += ' ' + this.config.snapshotOpts;
		if (this.config.imageRotate) cmd += ' -rot ' + this.config.imageRotate;
		if (this.config.imageWidth) cmd += ' -w ' + this.config.imageWidth;
		if (this.config.imageQuality) cmd += ' -q ' + this.config.imageQuality;
		return cmd;
	},
	
	handleSnapshot: function(args) {
		// take snapshot and return binary image
		var self = this;
		var fmt = this.config.imageFormat;
		var filename = "image." + fmt;
		var cmd = this.getSnapshotCommand() + " -o " + filename;
		this.logDebug(9, "Executing command: "+ cmd);
		
		cp.exec( cmd, {}, function(err, stdout, stderr) {
			self.logDebug(9, "SNAP STDOUT: " + stdout);
			self.logDebug(9, "SNAP STDERR: " + stderr);
			
			var buf = fs.readFileSync( filename );
			fs.unlinkSync( filename );
			
			var headers = {
				'Content-Type': "image/" + fmt.replace(/jpg/, 'jpeg'),
				'Content-Length': buf.length
			};
			
			self.sendHTTPResponse( args, "200 OK", headers, buf );
		} );
	},
	
	snapshotUpload: function() {
		// take snapshot and upload, store locally on fail
		var self = this;
		var dargs = this.getDateArgs();
		
		var fmt = this.config.imageFormat;
		var filename = this.config.filenamePrefix + (dargs.yyyy_mm_dd + '-' + dargs.hh_mi_ss).replace(/\W/g, '-') + '.' + fmt;
		var file = this.config.tempDir + '/' + filename;
		
		var cmd = this.getSnapshotCommand() + " -o " + file;
		this.logDebug(9, "Executing command: "+ cmd);
		
		cp.exec( cmd, {}, function(err, stdout, stderr) {
			self.logDebug(9, "IMAGE STDOUT: " + stdout);
			self.logDebug(9, "IMAGE STDERR: " + stderr);
			
			self.uploadAllFiles();
		});
	},
	
	uploadAllFiles: function() {
		// upload all files to the server
		// delete each local file upon success
		var self = this;
		var config = this.config;
		
		// only allow one of these tasks to run at once
		if (this.uploading) return;
		this.uploading = true;
		
		var files = fs.readdirSync( config.tempDir );
		if (!files.length) {
			this.uploading = false;
			return;
		}
		
		var file = config.tempDir + '/' + files.shift();
		
		// curl -T localfile.ext ftp://username:password@ftp.server.com/remotedir/
		var cmd = config.curlCommand + ' ' + config.curlOpts + ' -T ' + file;
		cmd += ' ftp://' + config.ftpUsername + ':' + config.ftpPassword + '@' + config.ftpHostname + '/';
		if (config.ftpDirectory) cmd += config.ftpDirectory + '/';
		cmd += ' && rm -v ' + file;
		
		this.logDebug(9, "Executing command: "+ cmd);
		
		cp.exec( cmd, { timeout: 86400 * 1000 }, function(err, stdout, stderr) {
			self.logDebug(9, "UPLOAD STDOUT: " + stdout);
			self.logDebug(9, "UPLOAD STDERR: " + stderr);
			self.uploading = false;
			self.uploadAllFiles();
		});
	},
	
	deleteOldFiles: function() {
		// delete old files from the server
		var self = this;
		var config = this.config;
		if (!config.keepDays) return;
		if (this.uploading) return;
		
		// get list of files on server
		// curl -l ftp://username:password@ftp.server.com/remotedir/
		var cmd = config.curlCommand + ' -l';
		cmd += ' ftp://' + config.ftpUsername + ':' + config.ftpPassword + '@' + config.ftpHostname + '/';
		if (config.ftpDirectory) cmd += config.ftpDirectory + '/';
		
		this.logDebug(9, "Executing command: "+ cmd);
		
		cp.exec( cmd, { timeout: 3600 * 1000 }, function(err, stdout, stderr) {
			self.logDebug(9, "LIST STDOUT: " + stdout);
			self.logDebug(9, "LIST STDERR: " + stderr);
			
			// convert DOS line endings and split into array
			// 2018-05-21-00-00-10.jpg
			var lines = stdout.toString().replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n/);
			var file_to_delete = '';
			var then = ((new Date()).getTime() / 1000) - (86400 * config.keepDays);
			
			for (var idx = 0, len = lines.length; idx < len; idx++) {
				var line = lines[idx];
				if (line.match(/(\d{4}\-\d{2}\-\d{2})/)) {
					var yyyy_mm_dd = RegExp.$1;
					var epoch = (new Date( yyyy_mm_dd + ' 00:00:00' )).getTime() / 1000;
					if (epoch < then) {
						file_to_delete = line;
						idx = len;
					}
				}
			}
			
			if (file_to_delete) {
				// now issue FTP delete command
				// curl -v ftp://username:password@ftp.server.com/ -Q "DELE www/raspberry/images/2018-05-20-00-00-18.jpg"
				self.logDebug(3, "Deleting old file: " + file_to_delete);
				
				var cmd = config.curlCommand + ' -l';
				cmd += ' ftp://' + config.ftpUsername + ':' + config.ftpPassword + '@' + config.ftpHostname + '/';
				cmd += ' -Q "DELE ';
				if (config.ftpDirectory) cmd += config.ftpDirectory + '/';
				cmd += file_to_delete + '"';
				
				self.logDebug(9, "Executing command: "+ cmd);
				
				cp.exec( cmd, { timeout: 3600 * 1000 }, function(err, stdout, stderr) {
					self.logDebug(9, "DELETE STDOUT: " + stdout);
					self.logDebug(9, "DELETE STDERR: " + stderr);
					
					// keep trying as long as we find old files
					self.deleteOldFiles();
					
				}); // cp.exec (delete)
			} // file_to_delete
		}); // cp.exec (list)
	},
	
	emit: function(name, args) {
		// poor man's event emitter
		if (this[name] && (typeof(this[name]) == 'function')) this[name](args);
		if (this.config.schedule[name]) this[ this.config.schedule[name] ](args);
	},
	
	tick: function() {
		// run every second, for periodic tasks
		// this.emit('tick');
		
		// also emit minute, hour and day events when they change
		var dargs = this.getDateArgs();
		if (dargs.min != this.lastTickDate.min) {
			this.emit('minute', dargs);
			this.emit( dargs.hh + ':' + dargs.mi, dargs );
			this.emit( ':' + dargs.mi, dargs );
		}
		if (dargs.hour != this.lastTickDate.hour) this.emit('hour', dargs);
		if (dargs.mday != this.lastTickDate.mday) this.emit('day', dargs);
		if (dargs.mon != this.lastTickDate.mon) this.emit('month', dargs);
		if (dargs.year != this.lastTickDate.year) this.emit('year', dargs);
		this.lastTickDate = dargs;
	},
	
	getDateArgs: function(thingy) {
		// return hash containing year, mon, mday, hour, min, sec
		// given epoch seconds, date object or date string
		if (!thingy) thingy = new Date();
		var date = (typeof(thingy) == 'object') ? thingy : (new Date( (typeof(thingy) == 'number') ? (thingy * 1000) : thingy ));
		var args = {
			epoch: Math.floor( date.getTime() / 1000 ),
			year: date.getFullYear(),
			mon: date.getMonth() + 1,
			mday: date.getDate(),
			wday: date.getDay(),
			hour: date.getHours(),
			min: date.getMinutes(),
			sec: date.getSeconds(),
			msec: date.getMilliseconds(),
			offset: 0 - (date.getTimezoneOffset() / 60)
		};
		
		args.yyyy = '' + args.year;
		if (args.mon < 10) args.mm = "0" + args.mon; else args.mm = '' + args.mon;
		if (args.mday < 10) args.dd = "0" + args.mday; else args.dd = '' + args.mday;
		if (args.hour < 10) args.hh = "0" + args.hour; else args.hh = '' + args.hour;
		if (args.min < 10) args.mi = "0" + args.min; else args.mi = '' + args.min;
		if (args.sec < 10) args.ss = "0" + args.sec; else args.ss = '' + args.sec;
		
		if (args.hour >= 12) {
			args.ampm = 'pm';
			args.hour12 = args.hour - 12;
			if (!args.hour12) args.hour12 = 12;
		}
		else {
			args.ampm = 'am';
			args.hour12 = args.hour;
			if (!args.hour12) args.hour12 = 12;
		}
		
		args.yyyy_mm_dd = args.yyyy + '/' + args.mm + '/' + args.dd;
		args.hh_mi_ss = args.hh + ':' + args.mi + ':' + args.ss;
		args.tz = 'GMT' + (args.offset >= 0 ? '+' : '') + args.offset;
		
		return args;
	},
	
	getIPAddress: function() {
		// determine server ip address
		// find the first external IPv4 address that doesn't match 169.254.
		var ifaces = os.networkInterfaces();
		var addrs = [];
		for (var key in ifaces) {
			addrs = addrs.concat( addrs, ifaces[key] );
		}
		
		var iaddrs = this.findObjects( addrs, { family: 'IPv4', internal: false } );
		for (var idx = 0, len = iaddrs.length; idx < len; idx++) {
			var addr = iaddrs[idx];
			if (addr && addr.address && addr.address.match(/^\d+\.\d+\.\d+\.\d+$/) && !addr.address.match(/^169\.254\./)) {
				// well that was easy
				return addr.address;
			}
		}
		
		var addr = iaddrs[0];
		if (addr && addr.address && addr.address.match(/^\d+\.\d+\.\d+\.\d+$/)) {
			// this will allow 169.254. to be chosen only after all other non-internal IPv4s are considered
			return addr.address;
		}
		
		return '127.0.0.1';
	},
	
	findObjectsIdx: function(arr, crit, max) {
		// find idx of all objects that match crit keys/values
		var idxs = [];
		var num_crit = 0;
		for (var a in crit) num_crit++;
		
		for (var idx = 0, len = arr.length; idx < len; idx++) {
			var matches = 0;
			for (var key in crit) {
				if (arr[idx][key] == crit[key]) matches++;
			}
			if (matches == num_crit) {
				idxs.push(idx);
				if (max && (idxs.length >= max)) return idxs;
			}
		} // foreach elem
		
		return idxs;
	},
	
	findObjectIdx: function(arr, crit) {
		// find idx of first matched object, or -1 if not found
		var idxs = this.findObjectsIdx(arr, crit, 1);
		return idxs.length ? idxs[0] : -1;
	},
	
	findObject: function(arr, crit) {
		// return first found object matching crit keys/values, or null if not found
		var idx = this.findObjectIdx(arr, crit);
		return (idx > -1) ? arr[idx] : null;
	},
	
	findObjects: function(arr, crit) {
		// find and return all objects that match crit keys/values
		var idxs = this.findObjectsIdx(arr, crit);
		var objs = [];
		for (var idx = 0, len = idxs.length; idx < len; idx++) {
			objs.push( arr[idxs[idx]] );
		}
		return objs;
	},
	
	shutdown: function() {
		// shutting down
		var self = this;
		this.logDebug(2, "Shutting down");
		
		// stop tick timer
		if (this.tickTimer) {
			clearTimeout( this.tickTimer );
			delete this.tickTimer;
		}
		
		if (this.http) {
			this.logDebug(3, "Shutting down HTTP server");
			
			for (var id in this.conns) {
				this.logDebug(9, "Closing HTTP connection: " + id);
				// this.conns[id].destroy();
				this.conns[id].end();
				this.conns[id].unref();
				this.numConns--;
			}
			
			this.http.close( function() { self.logDebug(3, "HTTP server has shut down."); } );
		}
		
		// delete pid file
		fs.unlinkSync( 'pid.txt' );
	},
	
	logDebug: function(level, msg, data) {
		var dargs = this.getDateArgs();
		var line = '[' + dargs.yyyy_mm_dd + ' ' + dargs.hh_mi_ss + '] ' + msg;
		if (data) line += " " + JSON.stringify(data);
		fs.appendFileSync( this.config.logFile, line + "\n" );
		if (this.debug) console.log(line);
	}
	
};

WebServer.startup();
