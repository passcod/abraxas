"use strict";
var packet = require('gearman-packet');
var toBuffer = packet.Emitter.prototype.toBuffer;
var stream = require('readable-stream');
var util = require('util');
var WorkerTask = require('./task-worker');
/*
----- WORKER
Send:
    ALL_YOURS: {id: 24, args: []},
*/

exports.__construct = function (init) {
    this._workers = {};
    this._workersCount = 0;

    this._activeJobs = {};
    this._activeJobsCount = 0;

    if (!this.options.maxJobs) {
        this.options.maxJobs = 1;
    }
    var self = this;
    this.on('__connect', function (conn) { 
        conn.socket.packets.accept('NO_JOB', function(data) {
            if (!conn.socket.socket) return;
            conn.socket.socket.write({kind:'request',type:packet.types['PRE_SLEEP']});
        });

        conn.socket.packets.accept('NOOP', function(data) { conn.socket.askForWork() });
        if (! this._workersCount) return;
        conn.socket.ref();
        conn.socket.packets.accept('JOB_ASSIGN_UNIQ', conn.socket.onJobAssign = function(job) { self.dispatchWorker(job) });
        for (var func in self._workers) {
            var worker = self._workers[worker];
            if (worker.options.timeout) {
                this.socket.write({kind:'request',type:packet.types['CAN_DO_TIMEOUT'], args:{function: func, timeout: worker.options.timeout}});
            }
            else {
                this.socket.write({kind:'request',type:packet.types['CAN_DO'], args:{function: func}});
            }
        }
    });

}

var Worker = exports.Worker = {};

Worker.setClientId = function (id) {
    self.socket.write({kind:'request',type:packet.types['SET_CLIENT_ID'], args:{workerid:id}});
}

// We defer this, so that the user has the oppportunity to register all of
// their workers
Worker.askForWork = function () {
    if (this.asked) return;
    this.asked = true;
    var self = this;
    setImmediate(function(){
        self.asked = false;
        if (!self.socket) return;
        self.socket.write({kind:'request',type:packet.types['GRAB_JOB_UNIQ']});
    });
}

Worker.startWork = function (jobid) {
    this._activeJobs[jobid] = true;
    if (this.options.maxJobs > ++ this._activeJobsCount) {
        this.askForWork();
    }
}

Worker.endWork = function (jobid) {
    delete this._activeJobs[jobid];
    if (this.options.maxJobs > -- this._activeJobsCount) {
        this.askForWork();
    }
}

Worker.unregisterWorker = function (func) {
    if (!this._workers[func]) {
        this.emit('warn', new Error("Unregistering worker "+func+" that's not registered, doing nothing"));
        return;
    }
    delete this._workers[func];
    if (-- this._workersCount == 0) {
        this.packets.removeHandler('JOB_ASSIGN_UNIQ', this.onJobAssign);
        this.unref();
    }
    if (!this.connected) return;
    this.socket.write({kind:'request',type:packet.types['CANT_DO'],args:{functon: func}});
}

Worker.registerWorker = function (func, options, worker) {
    if (!worker) { worker=options; options={} }
    if (this._workers[func]) {
        this.emit('warn', new Error('Redefining worker for '+func));
    }
    else if (this._workersCount++ == 0) {
        var self = this;
        this.getConnectedServers().forEach(function(conn) {
            conn.ref();
            conn.packets.accept('JOB_ASSIGN_UNIQ', conn.onJobAssign = function(job) { self.dispatchWorker(job) });
        });
    }
    this.getConnectedServers().forEach(function(conn) {
        if (options.timeout) {
            conn.socket.write({kind:'request',type:packet.types['CAN_DO_TIMEOUT'], args:{function: func, timeout: options.timeout}});
        }
        else {
            conn.socket.write({kind:'request',type:packet.types['CAN_DO'], args:{function: func}});
        }
    });
    this._workers[func] = {options: options, handler: worker};
    this.askForWork();
    var self = this;
    return {
        function: func,
        unregister: function () { return self.unregisterWorker(func) },
        maxqueue: function (maxsize,callback) { return self.maxqueue(func,maxsize,callback) },
        status: function (callback) {
            if (callback) {
                return self.status().then(function (status) {
                    return callback(null,status.filter(function(W){ return W.function==func })[0]);
                })
                .catch(function(err) {
                    return callback(err);
                });
            }
            else {
                return self.status().then(function (status) { return status.filter(function(W){ return W.function==func })[0]; })
            }
        }
    };
}

Worker.forgetAllWorkers = function () {
    if (! this._workersCount) return;
    this._workers = {};
    this._workersCount = 0;
    this.packets.removeHandler('JOB_ASSIGN_UNIQ', this.onJobAssign);
    this.unref();
    if (!this.connected) return;
    this.socket.write({kind:'request',type:packet.types['RESET_ABILITIES']});
}

Worker.dispatchWorker = function (job) {
    var self = this;
    var jobid = job.args.job;
    var worker = this._workers[job.args.function];
    if (!worker) return this.packets.emit('unknown',job);

    this.startWork(jobid);

    var options = {jobid: jobid, uniqueid: job.args.uniqueid, client: this};
    if (worker.options.encoding) options.encoding = worker.options.encoding;
    if (! options.encoding) options.encoding = this.options.defaultEncoding;
    if (options.encoding == 'buffer') options.encoding = null;
    if (options.encoding) job.body.setEncoding(options.encoding);

    var task = new WorkerTask(job.body,options);

    if (this.feature.streaming) {
        task.writer.on('data', function (data) {
            if (!self.connected) return;
            self.socket.write({kind:'request',type:packet.types['WORK_DATA'], args:{job:jobid}, body:data});
        });

        task.writer.on('end', function () {
            if (self.connected) {
                var end = {kind:'request',type:packet.types['WORK_COMPLETE'], args:{job:jobid}};
                if (task.lastChunk) end.body = task.lastChunk;
                self.socket.write(end, options.encoding);
            }
            self.endWork(jobid);
        });
        task.write.resume();
    }
    else {
        var buffer = new Buffer(0);
        var addToBuffer = function (thing) {
            buffer = Buffer.concat([buffer,toBuffer(thing)]);
        }
        task.writer.on('data', function (data) {
            if (!self.connected) return;
            addToBuffer(data);
        });

        task.writer.on('end', function () {
            if (self.connected) {
                if (task.lastChunk) addToBuffer(task.lastChunk);
                var end = {kind:'request',type:packet.types['WORK_COMPLETE'], args:{job:jobid}, body: buffer};
                self.socket.write(end, options.encoding);
            }
            self.endWork(jobid);
        });

        task.writer.resume();
    }
    
    try {
        var handleReturnValue = function (value) {
            if (value && value.pipe) {
                value.pipe(task);
                value.on('error', function (err) { task.error(err) });
            }
            else if (value && value.then) {
                value.then(handleReturnValue, function (err) { task.error(err) });
            }
            else if (value instanceof Error) {
                task.error(value);
            }
            else if (value != null) {
                task.end(value);
            }
        }

        handleReturnValue(worker.handler(task));
    }
    catch (error) {
        task.error(error);
    }
}
