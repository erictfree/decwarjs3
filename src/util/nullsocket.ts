import { Socket } from 'net';

export class NullSocket extends Socket {
    constructor() {
        super();

        // Optional: override any internal behavior if needed
        this.pause(); // ensure it doesn't try to read
    }

    override write(_data: any, _encoding?: any, _callback?: any): boolean {
        void _data;
        void _encoding;
        void _callback;
        return true;
    }

    override end(_data?: any, _encoding?: any, _callback?: any): this {
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