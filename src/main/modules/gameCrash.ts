import Observable from './observable';

export type CrashInfo = {
	code: number | null;
	signal: NodeJS.Signals | null;
	reportFile?: string;
	reportContent?: string;
	at: number;
};

class GameCrashClass extends Observable<CrashInfo | undefined> {
	protected _value: CrashInfo | undefined = undefined;

	notify(info: CrashInfo) {
		this._value = info;
		this._notifyObservers();
	}

	acknowledge() {
		this._value = undefined;
		this._notifyObservers();
	}
}

const GameCrash = new GameCrashClass();
export default GameCrash;
