import { Socket } from 'net';

export class NullSocket extends Socket {
    constructor() {
        super();

        // Optional: override any internal behavior if needed
        this.pause(); // ensure it doesn't try to read
    }

    override write(_data: unknown, _encoding?: unknown, _callback?: unknown): boolean {
        void _data;
        void _encoding;
        void _callback;
        return true;
    }

    override end(_data?: unknown, _encoding?: unknown, _callback?: unknown): this {
        void _data;
        void _encoding;
        void _callback;
        return this;
    }

    override destroy(_error?: Error): this {
        void _error;
        return this;
    }
}