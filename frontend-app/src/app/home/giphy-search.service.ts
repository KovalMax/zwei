import {HttpClient, HttpParams} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {catchError, distinctUntilChanged, finalize, map, Observable, of, shareReplay, switchMap, tap, throwError} from 'rxjs';
import {fromFetch} from 'rxjs/fetch';
import {parseGiphyMedia} from './giphy-media';
import {HostService} from '../auth/host.service';
import {AuthService} from '../auth/auth.service';

const GIPHY_KEY_TTL_MS = 15 * 60 * 1000;
const GIPHY_RESPONSE_MAX_BYTES = 1024 * 1024;
const GIPHY_REQUEST_TIMEOUT_MS = 15_000;
const GIPHY_SEARCH_ERROR = 'GIPHY search failed. Try again.';

export interface GiphySearchResult {
    id: string;
    title: string;
    url: string;
}

export interface GiphySearchPage {
    results: GiphySearchResult[];
    offset: number;
    count: number;
    totalCount: number;
    hasMore: boolean;
}

@Injectable({providedIn: 'root'})
export class GiphySearchService {
    private cachedKey?: string;
    private keyExpiresAt = 0;
    private keyRequest?: Observable<string>;
    private tokenGeneration = 0;

    constructor(private readonly http: HttpClient, private readonly host: HostService, auth: AuthService) {
        auth.token.pipe(
            map(token => token ? `${token.token_type} ${token.access_token}` : null),
            distinctUntilChanged(),
        ).subscribe(() => {
            this.tokenGeneration++;
            this.cachedKey = undefined;
            this.keyExpiresAt = 0;
            this.keyRequest = undefined;
        });
    }

    public search(query: string, offset = 0): Observable<GiphySearchPage> {
        const term = query.trim();
        if (!term || term.length > 50) return throwError(() => new Error('Enter a search term of 1 to 50 characters.'));
        if (!Number.isInteger(offset) || offset < 0 || offset > 4999) return throwError(() => new Error('GIPHY search offset is out of range.'));
        const search = this.getKey().pipe(switchMap(key => {
            const params = new HttpParams().set('api_key', key).set('q', term).set('limit', '50').set('offset', String(offset)).set('rating', 'g');
            const url = `https://api.giphy.com/v1/gifs/search?${params.toString()}`;
            const response = fromFetch(url, {
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                selector: response => {
                    if (!response.ok) throw new Error(GIPHY_SEARCH_ERROR);
                    return readBoundedJson(response);
                },
            }).pipe(
                catchError(() => throwError(() => new Error(GIPHY_SEARCH_ERROR))),
            );
            return response.pipe(map(payload => mapGiphySearchResponse(payload, offset)));
        }));
        return withDeadline(search, GIPHY_REQUEST_TIMEOUT_MS);
    }

    private getKey(): Observable<string> {
        if (this.cachedKey && Date.now() < this.keyExpiresAt) return of(this.cachedKey);
        if (this.keyRequest) return this.keyRequest;

        const generation = this.tokenGeneration;
        this.keyRequest = this.http.get<unknown>(this.host.authEndpoint('giphy-key')).pipe(
            map(readGiphyKey),
            map(key => {
                if (generation !== this.tokenGeneration) throw new Error('GIPHY search was interrupted. Try again.');
                return key;
            }),
            tap(key => {
                this.cachedKey = key;
                this.keyExpiresAt = Date.now() + GIPHY_KEY_TTL_MS;
            }),
            finalize(() => { if (this.keyRequest === request) this.keyRequest = undefined; }),
            shareReplay({bufferSize: 1, refCount: true}),
        );
        const request = this.keyRequest;
        return request;
    }
}

function withDeadline<T>(source: Observable<T>, deadlineMs: number): Observable<T> {
    return new Observable(subscriber => {
        const timer = setTimeout(() => {
            subscriber.error(new Error(GIPHY_SEARCH_ERROR));
        }, deadlineMs);
        const request = source.subscribe(subscriber);
        return () => {
            clearTimeout(timer);
            request.unsubscribe();
        };
    });
}

async function readBoundedJson(response: Response): Promise<unknown> {
    if (!response.body) throw new Error(GIPHY_SEARCH_ERROR);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteCount = 0;
    let text = '';
    let completed = false;
    let cancelled = false;
    const cancelBody = (): void => {
        if (cancelled) return;
        cancelled = true;
        void reader.cancel().catch(() => undefined);
    };
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
                completed = true;
                text += decoder.decode();
                break;
            }
            byteCount += chunk.value.byteLength;
            if (byteCount > GIPHY_RESPONSE_MAX_BYTES) {
                cancelBody();
                throw new Error(GIPHY_SEARCH_ERROR);
            }
            text += decoder.decode(chunk.value, {stream: true});
        }
        return JSON.parse(text) as unknown;
    } finally {
        if (!completed) cancelBody();
        reader.releaseLock();
    }
}

function readGiphyKey(payload: unknown): string {
    if (typeof payload !== 'object' || payload === null || !('api_key' in payload) || typeof payload.api_key !== 'string' || !payload.api_key.trim()) {
        throw new Error('GIPHY search is unavailable.');
    }
    return payload.api_key.trim();
}

function mapGiphySearchResponse(payload: unknown, requestedOffset: number): GiphySearchPage {
    if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) throw new Error('GIPHY returned an invalid search response.');
    if (!('meta' in payload) || !isRecord(payload.meta)) throw new Error('GIPHY returned an invalid search response.');
    const pagination = 'pagination' in payload && isRecord(payload.pagination)
        ? payload.pagination
        : 'pagination' in payload.meta && isRecord(payload.meta.pagination) ? payload.meta.pagination : null;
    if (!pagination) throw new Error('GIPHY returned an invalid search response.');
    const {offset, count, total_count: totalCount} = pagination;
    if (!Number.isInteger(offset) || !Number.isInteger(count) || !Number.isInteger(totalCount)
        || typeof offset !== 'number' || typeof count !== 'number' || typeof totalCount !== 'number'
        || offset !== requestedOffset || count < 0 || count > 50 || totalCount < 0 || offset + count > totalCount || payload.data.length !== count) {
        throw new Error('GIPHY returned an invalid search response.');
    }
    const items: unknown[] = payload.data;
    const results: GiphySearchResult[] = [];
    for (const item of items.slice(0, 50)) {
        if (!isRecord(item) || !isRecord(item.images)) throw new Error('GIPHY returned an invalid search response.');
        const {id, title, rating} = item;
        if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof rating !== 'string') throw new Error('GIPHY returned an invalid search response.');
        if (!('fixed_height' in item.images)) continue;
        if (!isRecord(item.images.fixed_height) || typeof item.images.fixed_height.url !== 'string') throw new Error('GIPHY returned an invalid search response.');
        const url = item.images.fixed_height.url;
        if (rating !== 'g') continue;
        const media = parseGiphyMedia(url);
        if (media?.kind === 'image') results.push({id, title: title.slice(0, 200), url: media.source});
    }
    const nextOffset = offset + count;
    return {results, offset, count, totalCount, hasMore: count > 0 && nextOffset <= 4999 && nextOffset < totalCount};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
