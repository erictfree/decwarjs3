declare module 'flat-file-db' {
    interface DB {
        put(key: string, value: unknown): void;
        get(key: string): unknown;
        has(key: string): boolean;
        del(key: string): void;
        keys(): string[];
        close(): void;
        on(event: 'open', callback: () => void): void;
    }
    export default function flatfile(path: string): DB;
}