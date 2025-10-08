// Tiny, lint-safe pagination helper

export type PageParams = Readonly<{
    page?: number;      // 1-based
    pageSize?: number;  // max items per page
    maxPageSize?: number; // enforcement cap
}>;

export type PageResult<T> = Readonly<{
    page: number;
    pageSize: number;
    total: number;
    items: readonly T[];
}>;

export function paginate<T>(
    source: readonly T[],
    params: PageParams = {}
): PageResult<T> {
    const total = source.length;
    const maxPageSize = Math.max(1, params.maxPageSize ?? 500);
    const pageSize = Math.min(Math.max(1, params.pageSize ?? 50), maxPageSize);
    const page = Math.max(1, params.page ?? 1);

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const items = source.slice(start, end);

    return { page, pageSize, total, items };
}
