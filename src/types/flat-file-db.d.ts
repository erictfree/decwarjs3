declare module 'flat-file-db' {
    interface DB {
        // eslint-disable-next-line no-unused-vars
        put(key: string, value: any): void;
        // eslint-disable-next-line no-unused-vars
        get(key: string): any;
        // eslint-disable-next-line no-unused-vars
        has(key: string): boolean;
        // eslint-disable-next-line no-unused-vars
        del(key: string): void;
        keys(): string[];
        close(): void;
        // eslint-disable-next-line no-unused-vars
        on(event: 'open', callback: () => void): void;
    }
    // eslint-disable-next-line no-unused-vars
    export default function flatfile(path: string): DB;
}