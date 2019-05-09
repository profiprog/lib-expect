import {ChildProcess} from 'child_process';
import * as fs from 'fs';

//----------------------------------------------------------------------------------------------------------------------
// Interfaces and types
//----------------------------------------------------------------------------------------------------------------------

export type ResetFn = () => any;
export type UndoFn = () => any;
export type Stream = 'stdout' | 'stderr';
export type StreamListener = (data: string) => void;

export type EventType = 'stdout' | 'stderr' | 'end';

export type LogWriter = (message: string) => void;

export type WatchID = string;

export interface ProcessExitState {
	events: Array<'close' | 'exit'>;
	code: number | null;
	signal: string | null;
}

export interface WatchEvent {
	type: 'match' | 'end' | 'timeout';
	watchId: WatchID;
	stdout: string;
	stderr: string;
}

export interface CloseEvent extends WatchEvent {
	exitState: ProcessExitState;
}

export interface TimeoutEvent extends WatchEvent {
	timeout: number;
	hitCount: number;
	resetCount: number;
	reset: () => void;
}

export interface MatchEvent extends  WatchEvent {
	type: 'match';
	pattern: RegExp | string;
	match: RegExpExecArray | null;
}

export interface MatchResult extends MatchEvent {
	match: RegExpExecArray;
	input: Stream;
	noFinal: () => true;
	consume?: () => void;
	replacement?: string;
	next?: () => boolean;
}

export type WatchHandler<T extends WatchEvent> = (event: T) => any;
export type Handler = WatchHandler<WatchEvent|CloseEvent|TimeoutEvent|MatchEvent>;

export type DataMatcher = (data: string) => MatchEvent;

//----------------------------------------------------------------------------------------------------------------------
// General functions which probably exist in some multifunctional library,
// but this project needs only those here defined
//----------------------------------------------------------------------------------------------------------------------

const undoablePush = <T>(array: T[], item: T): UndoFn => {
	array.push(item);
	return () => {
		let index = array.indexOf(item);
		if (index >= 0) array.splice(index, 1);
	};
};

const asRegExpMatchArray = (array: string[], index: number, input: string): RegExpExecArray => {
	let result = array as RegExpExecArray;
	result.index = index;
	result.input = input;
	return result;
};

const strMatch = (input: string, str: string): RegExpExecArray | null => (index =>
	index < 0 ? null : asRegExpMatchArray([str], index, input))(input.indexOf(str));

const getStack = (level = 1): string =>
	(new Error('x').stack || '').split('\n').slice(level + 1).join('\n');

const appendStack = (e: Error, stack: string, separator = '...'): Error => {
	if (stack) {
		e.stack += separator ? stack.replace(/^(\s*)/, `\n$1${separator}\n$1`) : '\n' + stack;
	}
	return e;
};

const merge = (...objs) => {
	let result: any = {};
	for (let obj of objs) for (let key of Object.keys(obj)) {
		if (!result.hasOwnProperty(key)) result[key] = obj[key];
		else if (Array.isArray(result[key]) && !Array.isArray(obj[key])) result[key].push(obj[key]);
		else if (typeof obj[key] === 'object'
			&& obj[key] !== null
			&& typeof result[key] === 'object'
			&& result[key] !== null
		) {
			if (Array.isArray(obj[key]) && Array.isArray(result[key])) result[key] = result[key].concat(obj[key]);
			else if (Array.isArray(obj[key])) result[key] = [result[key]].concat(obj[key]);
			else result[key] = merge(result[key], obj[key]);
		}
		else if (result[key] !== obj[key]) result[key] = [ result[key], obj[key] ];
	}
	return result;
};

//----------------------------------------------------------------------------------------------------------------------
// Main Library code
//----------------------------------------------------------------------------------------------------------------------

function transformColoredOutputToHTML(str: string): string {
	let closeTag: string = '';
	return str.replace(/\x1b\[([^m]+)m/g, (m, codes) => {
		// TODO implement substitution of color codes to HTML tags
		return '';
	});
}

const htmlHandler = (handler: LogWriter): LogWriter =>
	(msg: string) => handler(transformColoredOutputToHTML(msg));

const rawHandler = (handler: LogWriter): LogWriter =>
	(msg: string) => handler(msg.replace(/\x1b\[[^m]+m/g, ''));

function formatInput(input: string, match: RegExpExecArray | null = null) {
	let out = JSON.stringify(input);
	if (match) {
		let outputFrom = 1, inputFrom = 0;
		while (inputFrom < match.index) if (out.charAt(outputFrom++) !== '\\') inputFrom++;
		let outputTo = outputFrom, inputTo = inputFrom, refTo = match.index + match[0].length;
		while (inputTo < refTo) if (out.charAt(outputTo++) !== '\\') inputTo++;
		out = [
			out.substring(0, outputFrom), '\x1b[4m',
			out.substring(outputFrom, outputTo), '\x1b[0;35m',
			out.substring(outputTo),
		].join('');
	}
	return `\x1b[35m${out}\x1b[0m`;
}

function fileWriter(filename: string): LogWriter {
	return (msg: string) => {
		// TODO investigate more effective way?
		fs.appendFileSync(filename, msg, 'utf8');
	};
}

export class DataConsumer {
	private stdout = '';
	private stderr = '';
	private exitState?: ProcessExitState;
	private readonly handlers: { [eventType: string]: Array<() => void> } = {};
	private activator: WatchEvent[] | ((event: WatchEvent) => boolean) = [];
	protected pendingTimeoutEvents: TimeoutEvent[] = [];
	protected globalTimeouts: ResetFn[] = [];

	private watchIdCount = 0;
	private readonly watchers: { [watchId: string]: UndoFn } = {};

	private readonly matchers: { [stream: string]: DataMatcher[] } = {};
	public defaultTimeout = 1500;
	private echo = 4;
	private process: ChildProcess;

	private debug: LogWriter | null = null;

	public enableDebug(
		type: false | string | 1 | 2 | ((message: string) => void) = 2,
		format: 'color' | 'raw' | 'html' = 'color',
	) {
		let debugHandler: LogWriter | null = type === false ? null :
			type === 1 ? console.info.bind(console) :
			type === 2 ? console.warn.bind(console) :
			typeof type === 'function' ? type :
			fileWriter(type);

		this.debug = debugHandler === null ? null :
			format === 'raw' ? rawHandler(debugHandler) :
			format === 'html' ? htmlHandler(debugHandler) : debugHandler;
	}

	public ifExceeds(millis: number);
	public ifExceeds(millis: number, signal: string);
	public ifExceeds(millis: number, handler: () => any);
	public ifExceeds(millis: number, handlerOrSignal: (() => any) | string = 'SIGKILL') {
		let unregisterCloseHandler: ResetFn | undefined;
		let timeoutId: NodeJS.Timeout | null = null;
		let globalTimeout: () => void;
		const resetTimeout: ResetFn = () => {
			if (timeoutId != null) clearTimeout(timeoutId);
			timeoutId = setTimeout(globalTimeout, millis);
		};

		const clean = () => {
			if (timeoutId != null) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (unregisterCloseHandler) {
				unregisterCloseHandler();
				unregisterCloseHandler = undefined;
			}
			if (resetTimeout) {
				let index = this.globalTimeouts.indexOf(resetTimeout);
				if (index >= 0) this.globalTimeouts.splice(index, 1);
			}
		};
		globalTimeout = () => {
			clean();
			if (typeof handlerOrSignal === 'string') {
				if (this.process) {
					this.process.kill(handlerOrSignal);
					console.warn(`killed after global timeout (${millis}ms)`);
				}
				else throw new Error(`Cannot send ${handlerOrSignal} signal, no process is attached`);
			}
			else handlerOrSignal.call(this);
		};
		this.globalTimeouts.push(resetTimeout);
		unregisterCloseHandler = this.registerHandler('end', () => this.isEnd('exit') && clean());
		resetTimeout();
		return this;
	}

	public stdoutWrite(data: string) {
		this.stdout += data;
		if (1 === (this.echo & 1)) process.stdout.write(`\x1b[35m${data}\x1b[0m`);
		this.triggerEvent('stdout');
		this.activateMostAccurateMatcher('stdout');
	}

	public stderrWrite(data) {
		this.stderr += data;
		if (2 === (this.echo & 2)) process.stderr.write(`\x1b[31m${data}\x1b[0m`);
		this.triggerEvent('stderr');
		this.activateMostAccurateMatcher('stderr');
	}

	public isEnd(types: 'exit' | 'close' | Array<'exit' | 'close'> = ['exit', 'close']): boolean {
		let events: any = this.exitState && this.exitState.events;
		return !!events && !(typeof types === 'string' ? [types] : types).find(type => events.indexOf(type) < 0);
	}

	public end(exitState: ProcessExitState) {
		if (exitState.events.length !== 1) throw new Error('Illegal argument: ' + JSON.stringify(exitState));
		if (this.exitState && this.exitState.events.indexOf(exitState.events[0]) >= 0) {
			throw new Error('Additional exitState: ' + JSON.stringify(exitState));
		}
		this.exitState = this.exitState ? merge(this.exitState, exitState) : exitState;
		this.triggerEvent('end');
	}

	public triggerEvent(eventType: EventType): void {
		let handlers = this.handlers[eventType as string];
		if (handlers) handlers.forEach(handler => handler());
	}

	public registerHandler(event: EventType, handler: () => void): UndoFn {
		return undoablePush(this.handlers[event] || (this.handlers[event] = []), handler);
	}

	public enableEcho(...num) { num.forEach(n => this.echo |= n); return this; }

	public disableEcho(...num) { num.forEach(n => this.echo &= ~n); return this; }
	/**
	 * Unregister all Whach
	 */
	public cleanWatchers() {
		Object.keys(this.watchers).forEach(key => {
			this.watchers[key]();
			delete this.watchers[key];
		});
	}

	public logState(logWritter: LogWriter) {
		logWritter(`\x1b[31;4mconditions:\x1b[0;34m ${Object.keys(this.watchers).join('\x1b[0m, \x1b[34m')}\x1b[0m`);
		['stdout', 'stderr'].forEach(std => {
			if (this[std] || this.matchers[std] && this.matchers[std].length) {
				logWritter(`\x1b[31;4m${std}:\x1b[0;35m ${JSON.stringify(this[std])}\x1b[0m`);
				logWritter(`\x1b[31;4mmatchers(${this.matchers[std] ? this.matchers[std].length : 0}):\x1b[0m ` +
					(this.matchers[std] || []).map(matcher =>
						(e => `${e.watchId}:\x1b[33m${typeof e.pattern === 'string' ? JSON.stringify(e.pattern) : e.pattern}\x1b[0m`)
						(matcher(''))).join(', '));
			}
		});
	}

	public expect(cases: { [watchID: string]: Handler | any });
	public expect(timeout: number, action?: WatchHandler<TimeoutEvent> | any);
	public expect(matches: string | RegExp, action?: WatchHandler<MatchEvent> | any);
	public expect(close: null, action?: WatchHandler<CloseEvent> | any);
	public expect(
		input: { [watchID: string]: Handler } | number | string | RegExp | WatchID | null,
		action?: Handler | any,
	): Promise<RegExpExecArray | any> {

		if (input instanceof RegExp) input = this.onMatch(input);
		else if (typeof input === 'number') input = this.onTimeout(input);
		else if (input === null) input = this.onClose();
		if (typeof input === 'string') {
			if (!this.watchers.hasOwnProperty(input)) input = this.onMatch(input);
			return this.expect({[input]: action});
		}
		let cases = input as { [watchID: string]: Handler | any };
		return new Promise<RegExpExecArray | any>((resolve, reject) => {
			let stack = getStack(2);
			let consumeEvent = (event: WatchEvent): boolean => {
				let target = cases[event.watchId];
				let final = true, error = false, result: any;
				if (event.type === 'match') (event as MatchResult).noFinal = () => !(final = false);
				if (typeof target === 'function') {
					try {
						result = target(event);
					} catch (e) {
						if (this.debug) this.logState(this.debug);
						(appendStack(error = e, stack) as any).event = event;
					}
				}
				else result = target;
				(consume => consume && consume())((event as MatchResult).consume);
				if (final || error) {
					this.cleanWatchers();
					this.activator = [];
					if (error) reject(error);
					else resolve(result === undefined ? (event as MatchResult).match : result);
					return true;
				}
				this.pendingTimeoutEvents.forEach(e => e.reset());
				this.globalTimeouts.forEach(e => e());
				return (next => next ? next() : false)((event as MatchResult).next);
			};
			if (!Array.isArray(this.activator)) throw new Error('Unsupported nested expect calls');
			while (this.activator.length) if (consumeEvent(this.activator.shift() as WatchEvent)) return;
			if (this.pendingTimeoutEvents.length === 0) {
				cases[this.onTimeout()] = event => { throw new Error(event.watchId || event.type); };
			}
			this.activator = consumeEvent;
			this.activateMostAccurateMatcher('stdout');
			this.activateMostAccurateMatcher('stderr');
		});
	}

	public activate(event: WatchEvent): boolean {
		if (Array.isArray(this.activator)) {
			let index = 0;
			this.activator.forEach((e, i) => {
				if (e.type === 'match') index = i + 1;
			});
			if (index === this.activator.length) this.activator.push(event);
			else this.activator.splice(index, 0, event);
			return false;
		}
		else if (typeof this.activator === 'function') return this.activator(event);
		else throw new Error(`Illegal state!`);
	}

	public registerDataMatcher(std: Stream, handler: StreamListener): UndoFn {
		return undoablePush(this.matchers[std] || (this.matchers[std] = []), handler);
	}

	public onMatch(strOrRegExp: RegExp | string, std: Stream = 'stdout'): WatchID {
		let isString = typeof strOrRegExp === 'string';
		let watchId = this.addWatcher('match', this.registerDataMatcher(std, input => {
			return {
				watchId,
				type: 'match',
				pattern: strOrRegExp,
				match: isString ? strMatch(input, strOrRegExp as string) : input.match(strOrRegExp),
			};
		}));
		return watchId;
	}

	public onClose(filter: null | 'exit' | 'close' | Array<'exit' | 'close'> = ['exit', 'close']): WatchID {
		let handler;
		if (typeof filter === 'string') filter = [filter];
		let watchId = this.addWatcher('end', this.registerHandler('end', handler = () => {
			if (filter === null || this.isEnd(filter)) this.activate({
				watchId,
				type: 'end',
				exitState: this.exitState,
				stdout: this.stdout,
				stderr: this.stderr,
			} as CloseEvent);
		}));
		if (this.stdout === null) handler();
		return watchId;
	}

	/**
	 * Define watcher activated after
	 */
	public onTimeout(timeout = this.defaultTimeout): WatchID {
		let timeoutId: NodeJS.Timeout | null = null, event: TimeoutEvent;
		let watchId = this.addWatcher('timeout', () => {
			let index = this.pendingTimeoutEvents.indexOf(event);
			if (index >= 0) this.pendingTimeoutEvents.splice(index, 1);
			if (timeoutId !== null) clearTimeout(timeoutId);
		});
		event = {
			watchId,
			type: 'timeout',
			timeout,
			hitCount: 0,
			resetCount: 0,
			stdout: this.stdout,
			stderr: this.stderr,
			reset: () => {
				if (timeoutId !== null) {
					clearTimeout(timeoutId);
					event.resetCount++;
				}
				timeoutId = setTimeout(() => {
					event.hitCount++;
					timeoutId = null;
					this.activate(event);
				}, timeout);
			},
		};
		event.reset();
		return watchId;
	}

	/**
	 *  Send data to attached process
	 */
	public send(data: string): void {
		this.process.stdin.write(data);
	}

	/**
	 * Register watcher's undo function and returns WatchID
	 */
	protected addWatcher(watcherPrefix: string, fnToUnregisterWatcher: UndoFn): WatchID {
		let watchId = `${watcherPrefix}#${++this.watchIdCount}`;
		this.watchers[watchId] = fnToUnregisterWatcher;
		return watchId;
	}

	private activateMatch(event: MatchResult, std: Stream, reActivate): boolean {
		event.input = std;
		event.consume = () => {
			delete event.consume;
			if (typeof event.replacement === 'string') {
				this[std] =  this[std].substr(0, event.match.index)
					+ event.replacement
					+ this[std].substr(event.match.index + event.match[0].length);
			}
			else this[std] = this[std].substr(event.match.index + event.match[0].length);
		};
		if (reActivate) event.next = () => this.activateMostAccurateMatcher(std);
		return this.activate(event);
	}

	private activateMostAccurateMatcher(stream: Stream): boolean {
		if (this.matchers[stream] && this.matchers[stream].length) {
			let matches: MatchEvent[] = this.matchers[stream].map(h => h(this[stream]));
			let activeMatches: MatchResult[] = matches.filter(it => !!it.match) as MatchResult[];
			if (activeMatches.length > 1) activeMatches.sort((a, b) => a.match.index - b.match.index);
			if (this.debug) {
				let j =  '\n ~ ';
				this.debug(formatInput(this[stream], activeMatches.length ? activeMatches[0].match : null) + j +
					matches.map(m => `\x1b[${m === activeMatches[0] ? '4;' : ''}33m${
						typeof m.pattern === 'string' ? JSON.stringify(m.pattern) : m.pattern}\x1b[0m -> \x1b[${
						m.match ? 32 : 31}m${!!m.match}${m.match ? ` (${m.match.index})` : ''}\x1b[0m`).join(j));
			}
			if (activeMatches.length) return this.activateMatch(activeMatches[0], stream, activeMatches.length > 1);
		}
		return false;
	}

	public static forChildProcess(childProcess: ChildProcess, result = new DataConsumer()): DataConsumer {
		result.process = childProcess;
		result.process.stdout.on('data', data => result.stdoutWrite(data));
		result.process.stderr.on('data', data => result.stderrWrite(data));
		result.process.on('error', err => {
			console.error('Failed to start subprocess', err);
		});
		let ends = ['exit', 'close'].map(event => new Promise<ProcessExitState>(resolve =>
			result.process.on(event, (code, signal) => resolve({events: [event], code, signal} as ProcessExitState)),
		));

		ends.forEach(end => end.then(ee => {
			if (4 === (result.echo & 4)) {
				console.info(`\x1b[33mChild process "\x1b[1;33m${
					ee.events.join(',')}\x1b[0;33m" with code \x1b[${ee.code ? 31 : 32}m${ee.code}\x1b[33m${
					ee.signal ? ` (${ee.signal})` : ''}\x1b[0m`);
			}
		}));
		ends.forEach(end => end.then(ee => result.end(ee)));
		return result;
	}

}

//----------------------------------------------------------------------------------------------------------------------
// CLI interface (Later)
//----------------------------------------------------------------------------------------------------------------------
