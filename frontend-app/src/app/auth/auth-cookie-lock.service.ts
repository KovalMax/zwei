import {Injectable} from '@angular/core';
import {defer, Observable, Subscription, throwError} from 'rxjs';

export const AUTH_LOCK_RECOVERY = 'This browser cannot safely manage sessions. Use an up-to-date browser with Web Locks enabled, then try again.';
export class AuthCookieLockUnavailableError extends Error {
    override name = 'AuthCookieLockUnavailableError';
    constructor() { super(AUTH_LOCK_RECOVERY); }
}

/** Serializes cookie-mutating auth requests across same-origin tabs where supported. */
@Injectable({providedIn: 'root'})
export class AuthCookieLockService {
    run<T>(request: () => Observable<T>): Observable<T> {
        return defer(() => {
            if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return throwError(() => new AuthCookieLockUnavailableError());
            return new Observable<T>(subscriber => {
                const abort = new AbortController();
                const active = new Subscription();
                let release: (() => void) | undefined;
                void navigator.locks.request('zwei-refresh', {signal: abort.signal}, () => new Promise<void>(resolve => {
                    release = resolve;
                    if (subscriber.closed) { resolve(); return; }
                    active.add(defer(request).subscribe({
                        next: value => subscriber.next(value),
                        error: error => { subscriber.error(error); resolve(); },
                        complete: () => { subscriber.complete(); resolve(); },
                    }));
                })).catch(error => { if (!subscriber.closed) subscriber.error(error); });
                return () => {
                    abort.abort();
                    active.unsubscribe();
                    release?.();
                };
            });
        });
    }
}
