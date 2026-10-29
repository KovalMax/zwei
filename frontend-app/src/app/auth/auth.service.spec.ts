import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { backends } from '../../environments/environment';
import { backends as productionBackends } from '../../environments/environment.prod';
import { AuthService } from './auth.service';
import { HostService } from './host.service';
import { AuthCookieLockService } from './auth-cookie-lock.service';
import { RegistrationService } from '../registration/registration.service';
import { RegistrationModel } from '../registration/registration.model';

describe('AuthService', () => {
    const jwt = (sub: string, suffix = '') => `header.${btoa(JSON.stringify({sub}))}.${suffix || 'signature'}`;
    let service: AuthService;
    let http: HttpTestingController;

    beforeEach(() => {
        localStorage.removeItem('zwei.intended-session');
        localStorage.removeItem('zwei.pending-logout');
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback()}});
        TestBed.configureTestingModule({ imports: [HttpClientTestingModule], providers: [RegistrationService] });
        service = TestBed.inject(AuthService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => { http.verify(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('signals accepted sessions, cross-tab invalidation and local logout', () => {
        let changes = 0;
        const subscription = service.sessionChanges.subscribe(() => changes++);
        const token = (subject: string, generation: string) => ({browser_id: 'browser', generation, token_type: 'Bearer', access_token: jwt(subject), expires_in: 900});
        service.acceptToken(token('a', 'one'));
        service.acceptToken(token('b', 'two'));
        expect(changes).toBe(2);
        localStorage.setItem('zwei.intended-session', JSON.stringify({subject: 'c', browser_id: 'browser', generation: 'three'}));
        window.dispatchEvent(new StorageEvent('storage', {key: 'zwei.intended-session'}));
        expect(changes).toBe(3);
        service.acceptToken(token('a', 'four'));
        service.logout(false).subscribe();
        expect(changes).toBe(5);
        subscription.unsubscribe();
    });

    it('detects a changed binding before a storage event arrives', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        localStorage.setItem('zwei.intended-session', JSON.stringify({subject: 'b', browser_id: 'browser', generation: 'two'}));
        expect(service.sessionIsCurrent()).toBe(false);
        expect(service.token.value).toBeNull();
    });

    it('does not signal a session transition for a same-session refresh', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: -1});
        let changes = 0;
        const subscription = service.sessionChanges.subscribe(() => changes++);
        service.restore().subscribe();
        http.expectOne(`${backends.auth}/api/auth/v2/refresh`).flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('a', 'new'), expires_in: 900});
        expect(changes).toBe(0);
        expect(service.sessionIsCurrent()).toBe(true);
        subscription.unsubscribe();
    });

    it('persists sign out during initial restore and retries after a lost refresh response', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(binding));
        service.restore().subscribe();
        const refresh = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        let failed = false;
        service.logout().subscribe({error: () => failed = true});
        const pending = JSON.parse(localStorage.getItem('zwei.pending-logout')!);
        expect(pending).toEqual({...binding, receipt: expect.any(String)});
        refresh.flush({}, {status: 503, statusText: 'Lost response'});
        const retry = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(retry.request.body).toEqual(pending);
        retry.flush({}, {status: 401, statusText: 'No cookie'});
        expect(failed).toBe(true);
        expect(service.pendingLogout).toBe(true);
    });

    it('completes initial restore logout even when the caller cancels', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(binding));
        service.restore().subscribe();
        const refresh = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        const subscription = service.logout().subscribe();
        subscription.unsubscribe();
        refresh.flush({...binding, token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        const logout = http.expectOne(`${backends.auth}/api/auth/v2/logout`);
        logout.flush(null);
        expect(service.pendingLogout).toBe(false);
    });

    it('does not revoke a newer binding after a lost in-flight refresh', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        const newer = {subject: 'b', browser_id: 'browser', generation: 'two'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(binding));
        service.restore().subscribe();
        const refresh = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        let failed = false;
        service.logout().subscribe({error: () => failed = true});
        const pending = localStorage.getItem('zwei.pending-logout');
        localStorage.setItem('zwei.intended-session', JSON.stringify(newer));
        refresh.flush({}, {status: 503, statusText: 'Lost response'});
        expect(failed).toBe(true);
        expect(localStorage.getItem('zwei.pending-logout')).toBe(pending);
        expect(JSON.parse(localStorage.getItem('zwei.intended-session')!)).toEqual(newer);
        http.expectNone(`${backends.auth}/api/auth/v2/logout/retry`);
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('offers durable recovery when logout follows an ambiguous failed restore', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(binding));
        service.restore().subscribe();
        http.expectOne(`${backends.auth}/api/auth/v2/refresh`).flush({}, {status: 503, statusText: 'Lost response'});
        let failed = false;
        service.logout().subscribe({error: () => failed = true});
        const retry = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(retry.request.body).toEqual({...binding, receipt: expect.any(String)});
        retry.flush({}, {status: 401, statusText: 'No cookie'});
        expect(failed).toBe(true);
        expect(service.pendingLogout).toBe(true);
    });

    it('persists only a scoped receipt and retries the same operation after reload', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        service.acceptToken({...binding, token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        service.logout().subscribe({error: () => {}});
        const pending = JSON.parse(localStorage.getItem('zwei.pending-logout')!);
        expect(pending).toEqual({...binding, receipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)});
        const initial = http.expectOne(`${backends.auth}/api/auth/v2/logout`);
        expect(initial.request.body).toEqual({browser_id: 'browser', generation: 'one', receipt: pending.receipt});
        initial.flush({}, {status: 503, statusText: 'Unavailable'});
        const reloaded = new AuthService(TestBed.inject(HttpClient), TestBed.inject(HostService), TestBed.inject(AuthCookieLockService));
        reloaded.restore().subscribe(value => expect(value).toBeNull());
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        reloaded.retryPendingLogout().subscribe();
        const retry = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(retry.request.body).toEqual(pending);
        expect(retry.request.withCredentials).toBe(true);
        retry.flush(null);
        expect(localStorage.getItem('zwei.pending-logout')).toBeNull();
        reloaded.ngOnDestroy();
    });

    it('uses cookie proof without rotating an expired session and retains intent on failure', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        service.acceptToken({...binding, token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        service.logout().subscribe({error: () => {}});
        expect(JSON.parse(localStorage.getItem('zwei.pending-logout')!)).toEqual({...binding, receipt: expect.any(String)});
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        const request = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(request.request.body).toEqual(JSON.parse(localStorage.getItem('zwei.pending-logout')!));
        request.flush({}, {status: 503, statusText: 'Unavailable'});
        const reloaded = new AuthService(TestBed.inject(HttpClient), TestBed.inject(HostService), TestBed.inject(AuthCookieLockService));
        expect(reloaded.pendingLogout).toBe(true);
        reloaded.restore().subscribe(value => expect(value).toBeNull());
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        reloaded.ngOnDestroy();
    });

    it('holds the cookie lock across cookie-proof logout against a queued login', async () => {
        const queue: Array<() => void> = [];
        let locked = false;
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<void>) => new Promise<void>((resolve, reject) => {
            const start = () => {
                locked = true;
                callback().then(resolve, reject).finally(() => {
                    locked = false;
                    queue.shift()?.();
                });
            };
            if (locked) queue.push(start); else start();
        })}});
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        const other = new AuthService(TestBed.inject(HttpClient), TestBed.inject(HostService), TestBed.inject(AuthCookieLockService));
        service.logout().subscribe({error: () => {}});
        // Simulate a login already queued before it can inspect the persisted intent.
        let loginFailed = false;
        const intent = localStorage.getItem('zwei.pending-logout')!;
        localStorage.removeItem('zwei.pending-logout');
        other.login({email: 'b@example.test', password: 'password'}).subscribe({error: () => loginFailed = true});
        localStorage.setItem('zwei.pending-logout', intent);
        http.expectNone(`${backends.auth}/api/auth/v2/login`);
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        const logout = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(logout.request.body).toEqual({subject: 'a', browser_id: 'browser', generation: 'one', receipt: expect.any(String)});
        logout.flush({}, {status: 503, statusText: 'Unavailable'});
        await vi.waitFor(() => expect(loginFailed).toBe(true));
        http.expectNone(`${backends.auth}/api/auth/v2/login`);
        other.ngOnDestroy();
    });

    it('retains the intent on failure and refuses to retry against a different tab binding', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one', receipt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'};
        localStorage.setItem('zwei.pending-logout', JSON.stringify(binding));
        service.retryPendingLogout().subscribe({error: () => {}});
        http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`).flush({}, {status: 503, statusText: 'Unavailable'});
        expect(JSON.parse(localStorage.getItem('zwei.pending-logout')!)).toEqual(binding);
        localStorage.setItem('zwei.intended-session', JSON.stringify({...binding, subject: 'b'}));
        let failed = false;
        service.retryPendingLogout().subscribe({error: () => failed = true});
        expect(failed).toBe(true);
        http.expectNone(`${backends.auth}/api/auth/v2/logout/retry`);
    });

    it('does not clear a newer pending intent when an older retry completes', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one', receipt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'};
        const newer = {...binding, receipt: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA'};
        localStorage.setItem('zwei.pending-logout', JSON.stringify(binding));
        let failure: unknown;
        service.retryPendingLogout().subscribe({error: error => failure = error});
        const retry = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        localStorage.setItem('zwei.pending-logout', JSON.stringify(newer));
        retry.flush(null);
        expect(failure).toBeTruthy();
        expect(JSON.parse(localStorage.getItem('zwei.pending-logout')!)).toEqual(newer);
    });

    it('explicitly abandons an unconfirmed intent without claiming revocation', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(binding));
        localStorage.setItem('zwei.pending-logout', JSON.stringify({...binding, receipt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}));
        let done = false;
        service.abandonPendingLogout().subscribe(() => done = true);
        expect(done).toBe(true);
        expect(service.pendingLogout).toBe(false);
        expect(localStorage.getItem('zwei.intended-session')).toBeNull();
        expect(service.token.value).toBeNull();
        http.expectNone(`${backends.auth}/api/auth/v2/logout/retry`);
    });

    it('discards malformed pending state only on explicit action and preserves any intended binding', () => {
        const intended = JSON.stringify({subject: 'b', browser_id: 'other', generation: 'two'});
        const malformed = ['', '{', JSON.stringify({subject: 4, browser_id: 'browser', generation: 'one', receipt: 'bad'}),
            JSON.stringify({subject: 'a', browser_id: 'browser', generation: 'one', receipt: 'bad'})];
        for (const raw of malformed) for (const withIntended of [false, true]) {
            localStorage.removeItem('zwei.intended-session');
            if (withIntended) localStorage.setItem('zwei.intended-session', intended);
            localStorage.setItem('zwei.pending-logout', raw);
            service.restore().subscribe(value => expect(value).toBeNull());
            let retryFailed = false;
            service.retryPendingLogout().subscribe({error: () => retryFailed = true});
            expect(retryFailed).toBe(true);
            expect(localStorage.getItem('zwei.pending-logout')).toBe(raw);
            let done = false;
            service.abandonPendingLogout().subscribe(() => done = true);
            expect(done).toBe(true);
            expect(localStorage.getItem('zwei.pending-logout')).toBeNull();
            expect(localStorage.getItem('zwei.intended-session')).toBe(withIntended ? intended : null);
        }
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        http.expectNone(`${backends.auth}/api/auth/v2/logout/retry`);
    });

    it('does not discard a pending intent that changed before abandonment', () => {
        const binding = {subject: 'a', browser_id: 'browser', generation: 'one'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(binding));
        localStorage.setItem('zwei.pending-logout', JSON.stringify({...binding, receipt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}));
        const original = Storage.prototype.getItem;
        let reads = 0;
        const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
            if (key === 'zwei.pending-logout' && ++reads === 2) this.setItem(key, 'newer');
            return original.call(this, key);
        });
        let failed = false;
        service.abandonPendingLogout().subscribe({error: () => failed = true});
        spy.mockRestore();
        expect(failed).toBe(true);
        expect(localStorage.getItem('zwei.pending-logout')).toBe('newer');
        expect(localStorage.getItem('zwei.intended-session')).toBe(JSON.stringify(binding));
    });

    it('never performs legacy refresh during v2 bootstrap', () => {
        let restored: unknown = 'pending';
        service.restore().subscribe(value => restored = value);
        expect(restored).toBeNull();
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
    });

    it('does not rotate or revoke without Web Locks and reports logout failure', () => {
        vi.stubGlobal('navigator', {});
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        service.restore().subscribe(value => expect(value).toBeNull());
        expect(service.restoreFailure).toBe('lock-unavailable');
        let failure: unknown;
        service.logout().subscribe({error: error => failure = error});
        expect(failure).toEqual(expect.objectContaining({name: 'AuthCookieLockUnavailableError'}));
        expect(service.token.value).toBeNull();
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('does not send credentials without Web Locks', () => {
        vi.stubGlobal('navigator', {});
        let failure: unknown;
        service.login({email: 'a@example.test', password: 'password'}).subscribe({error: error => failure = error});
        expect(failure).toEqual(expect.objectContaining({name: 'AuthCookieLockUnavailableError'}));
        http.expectNone(`${backends.auth}/api/auth/v2/login`);
    });

    it('restores only the durable intended binding after a page reload', () => {
        localStorage.setItem('zwei.intended-session', JSON.stringify({subject: 'a', browser_id: 'browser', generation: 'one'}));
        service.restore().subscribe(token => expect(token?.access_token).toBe(jwt('a', 'new')));
        const refresh = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        expect(refresh.request.body).toEqual({browser_id: 'browser', generation: 'one'});
        refresh.flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('a', 'new'), expires_in: 900});
        expect(JSON.parse(localStorage.getItem('zwei.intended-session')!)).toEqual({subject: 'a', browser_id: 'browser', generation: 'two'});
    });

    it.each(['not json', '{}', '{"subject":"a","browser_id":"browser","generation":""}'])('does not restore corrupt binding %s', raw => {
        localStorage.setItem('zwei.intended-session', raw);
        service.restore().subscribe(token => expect(token).toBeNull());
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
    });

    it('fails closed when binding storage cannot be read or written', () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
        service.restore().subscribe(token => expect(token).toBeNull());
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        get.mockRestore();
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
        expect(() => service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900})).toThrow();
        expect(service.token.value).toBeNull();
    });

    it('does not overwrite a binding changed while refresh was pending', () => {
        localStorage.setItem('zwei.intended-session', JSON.stringify({subject: 'a', browser_id: 'browser', generation: 'one'}));
        service.restore().subscribe(token => expect(token).toBeNull());
        const refresh = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        const newer = {subject: 'a', browser_id: 'browser', generation: 'other'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(newer));
        refresh.flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        expect(JSON.parse(localStorage.getItem('zwei.intended-session')!)).toEqual(newer);
        expect(service.token.value).toBeNull();
    });

    it('invalidates an outdated tab on storage change without touching the new binding or revoking', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        const newer = {subject: 'b', browser_id: 'other', generation: 'two'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(newer));
        window.dispatchEvent(new StorageEvent('storage', {key: 'zwei.intended-session'}));
        expect(service.token.value).toBeNull();
        expect(JSON.parse(localStorage.getItem('zwei.intended-session')!)).toEqual(newer);
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('checks the current binding rather than invalidating on a delayed storage event', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        window.dispatchEvent(new StorageEvent('storage', {key: 'zwei.intended-session', newValue: null}));
        expect(service.token.value?.access_token).toBe(jwt('a'));
    });

    it('keeps a live tab signed in when another tab refreshes the same binding', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        const binding = localStorage.getItem('zwei.intended-session');
        window.dispatchEvent(new StorageEvent('storage', {key: 'zwei.intended-session', newValue: binding}));
        expect(service.token.value?.access_token).toBe(jwt('a'));
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('reports transient refresh failure and allows a successful retry', () => {
        localStorage.setItem('zwei.intended-session', JSON.stringify({subject: 'a', browser_id: 'browser', generation: 'one'}));
        service.restore().subscribe(value => expect(value).toBeNull());
        http.expectOne(`${backends.auth}/api/auth/v2/refresh`).flush({}, {status: 503, statusText: 'Unavailable'});
        expect(service.restoreFailure).toBe('temporarily-unavailable');
        service.restore().subscribe(value => expect(value?.access_token).toBe(jwt('a', 'new')));
        http.expectOne(`${backends.auth}/api/auth/v2/refresh`).flush({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a', 'new'), expires_in: 900});
        expect(service.restoreFailure).toBeNull();
    });

    it('checks ownership after acquiring the cookie lock before local removal', async () => {
        let grant: (() => Promise<void>) | undefined;
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
            grant = callback;
            return new Promise<void>(() => undefined);
        }}});
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        let completed = false;
        service.logout(false).subscribe(() => completed = true);
        expect(completed).toBe(false);
        const newer = {subject: 'b', browser_id: 'other', generation: 'two'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(newer));
        await grant?.();
        expect(completed).toBe(true);
        expect(JSON.parse(localStorage.getItem('zwei.intended-session')!)).toEqual(newer);
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('does not establish a logout intent or revoke a session replaced while waiting for the lock', async () => {
        let grant: (() => Promise<void>) | undefined;
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
            grant = callback;
            return new Promise<void>(() => undefined);
        }}});
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        let failure: unknown;
        service.logout().subscribe({error: error => failure = error});
        expect(localStorage.getItem('zwei.pending-logout')).toBeNull();
        const newer = {subject: 'b', browser_id: 'other', generation: 'two'};
        localStorage.setItem('zwei.intended-session', JSON.stringify(newer));
        await grant?.();
        expect(failure).toBeTruthy();
        expect(localStorage.getItem('zwei.pending-logout')).toBeNull();
        expect(JSON.parse(localStorage.getItem('zwei.intended-session')!)).toEqual(newer);
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('does not overwrite a different pending logout or report success', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        const other = {subject: 'b', browser_id: 'other', generation: 'two'};
        localStorage.setItem('zwei.pending-logout', JSON.stringify(other));
        let failure: unknown;
        service.logout().subscribe({error: error => failure = error});
        expect(failure).toBeTruthy();
        expect(JSON.parse(localStorage.getItem('zwei.pending-logout')!)).toEqual(other);
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('reports failure and sends no revocation if saving the intent fails', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
        let failure: unknown;
        service.logout().subscribe({error: error => failure = error});
        expect(failure).toBeTruthy();
        expect(service.token.value).toBeNull();
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('finishes local cleanup after its caller unsubscribes while waiting for the lock', async () => {
        let grant: (() => Promise<void>) | undefined;
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
            grant = callback;
            return new Promise<void>(() => undefined);
        }}});
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        const subscription = service.logout(false).subscribe();
        subscription.unsubscribe();
        await grant?.();
        expect(localStorage.getItem('zwei.intended-session')).toBeNull();
    });

    it('fails closed without Web Locks if storage becomes unreadable with a live token', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
        service.restore().subscribe(token => expect(token).toBeNull());
        expect(service.token.value).toBeNull();
    });

    it('does not restore a refresh after logout', () => {
        localStorage.setItem('zwei.intended-session', JSON.stringify({subject: 'a', browser_id: 'browser', generation: 'one'}));
        service.restore().subscribe(token => expect(token).toBeNull());
        const refresh = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        service.logout(false).subscribe();
        refresh.flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        expect(localStorage.getItem('zwei.intended-session')).toBeNull();
        expect(service.token.value).toBeNull();
    });

    it.each([
        {subject: 'a', browser_id: 'browser', generation: 'newer'},
        {subject: 'b', browser_id: 'other', generation: 'newer'},
    ])('does not erase a newer tab binding on local logout: $subject', newer => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        localStorage.setItem('zwei.intended-session', JSON.stringify(newer));
        service.logout(false).subscribe();
        expect(JSON.parse(localStorage.getItem('zwei.intended-session')!)).toEqual(newer);
        expect(service.token.value).toBeNull();
    });

    it('uses v2 login, renews an expired selected session and revokes its new generation', () => {
        const base = `${backends.auth}/api/auth/v2`;
        service.login({email: 'a@example.test', password: 'password'}).subscribe();
        const login = http.expectOne(`${base}/login`);
        expect(login.request.withCredentials).toBe(true);
        login.flush({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        service.restore().subscribe();
        const refresh = http.expectOne(`${base}/refresh`);
        expect(refresh.request.body).toEqual({browser_id: 'browser', generation: 'one'});
        expect(refresh.request.withCredentials).toBe(true);
        refresh.flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('a', 'new'), expires_in: 900});
        service.logout().subscribe();
        const logout = http.expectOne(`${base}/logout`);
        expect(logout.request.body).toEqual({browser_id: 'browser', generation: 'two', receipt: expect.any(String)});
        expect(logout.request.headers.get('Authorization')).toBe(`Bearer ${jwt('a', 'new')}`);
        expect(logout.request.withCredentials).toBe(true);
        logout.flush(null);
    });

    it('fails closed if a v2 refresh changes browser or account', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        service.restore().subscribe(value => expect(value).toBeNull());
        http.expectOne(`${backends.auth}/api/auth/v2/refresh`).flush({browser_id: 'other', generation: 'two', token_type: 'Bearer', access_token: jwt('b'), expires_in: 900});
        expect(service.token.value).toBeNull();
    });

    it('logs out an expired session with its existing cookie and selector', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        service.logout().subscribe();
        expect(service.token.value).toBeNull();
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        const logout = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(logout.request.body).toEqual({subject: 'a', browser_id: 'browser', generation: 'one', receipt: expect.any(String)});
        logout.flush(null);
        expect(service.token.value).toBeNull();
    });

    it('reports revocation failure and retries with the receipt', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        let failed = false;
        service.logout().subscribe({error: () => failed = true});
        http.expectOne(`${backends.auth}/api/auth/v2/logout`).flush({}, {status: 503, statusText: 'Unavailable'});
        expect(failed).toBe(true);
        expect(service.token.value).toBeNull();
        service.logout().subscribe();
        const retry = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(retry.request.body.receipt).toEqual(expect.any(String));
        retry.flush(null);
    });

    it.each([
        [409, 'sessions revoked; refresh cookie ownership mismatch'],
        [500, 'sessions revoked; could not verify refresh cookie'],
    ])('does not retry or restore after confirmed revocation with an uncleared cookie (%s)', (status, message) => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        let failure: unknown;
        service.logout().subscribe({error: error => failure = error});
        http.expectOne(`${backends.auth}/api/auth/v2/logout`).flush({error: message}, {status, statusText: 'Error'});
        expect(failure).toEqual(expect.objectContaining({name: 'LogoutCookieUnclearedError'}));
        service.restore().subscribe(token => expect(token).toBeNull());
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        service.logout().subscribe({error: () => {}});
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('retries expired-token logout after a transient cookie-proof failure', async () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        let failed = false;
        service.logout().subscribe({error: () => failed = true});
        http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`).flush({}, {status: 503, statusText: 'Unavailable'});
        await vi.waitFor(() => expect(failed).toBe(true));
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
        service.logout().subscribe();
        const request = http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`);
        expect(request.request.body.receipt).toEqual(expect.any(String));
        request.flush(null);
    });

    it('accepts a token issued by registration into memory', () => {
        service.acceptToken({ browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900 });

        expect(service.token.value?.access_token).toBe(jwt('a'));
        expect(service.token.value?.expires_in).toBeGreaterThan(Date.now());
    });

    it('renews an expired token once for concurrent callers', async () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        const results: Array<string | undefined> = [];
        service.restore().subscribe(token => results.push(token?.access_token));
        service.restore().subscribe(token => results.push(token?.access_token));
        const request = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        expect(request.request.withCredentials).toBe(true);
        request.flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('a', 'new'), expires_in: 900});
        await vi.waitFor(() => expect(results).toEqual([jwt('a', 'new'), jwt('a', 'new')]));
    });

    it('waits for an in-flight rotation before revoking and never restores local state', async () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        service.restore().subscribe();
        const refresh = http.expectOne(`${backends.auth}/api/auth/v2/refresh`);
        service.logout().subscribe();
        expect(service.token.value).toBeNull();
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
        refresh.flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('a', 'new'), expires_in: 900});
        await Promise.resolve();
        await Promise.resolve();
        expect(service.token.value).toBeNull();
        const logout = http.expectOne(`${backends.auth}/api/auth/v2/logout`);
        expect(logout.request.headers.get('Authorization')).toBe(`Bearer ${jwt('a', 'new')}`);
        logout.flush(null);
    });

    it('rejects a refresh belonging to another account', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        let result: unknown = 'pending';
        service.restore().subscribe(token => result = token);
        http.expectOne(`${backends.auth}/api/auth/v2/refresh`).flush({browser_id: 'browser', generation: 'two', token_type: 'Bearer', access_token: jwt('b'), expires_in: 900});
        expect(result).toBeNull();
        expect(service.token.value).toBeNull();
    });

    it('fails closed when either renewal identity is malformed', () => {
        expect(() => service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: 'malformed', expires_in: 0})).toThrow();
        service.restore().subscribe(token => expect(token).toBeNull());
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        expect(service.token.value).toBeNull();
    });

    it('does not report success when cookie proof is rejected', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 0});
        let failed = false;
        service.logout().subscribe({error: () => failed = true});
        http.expectNone(`${backends.auth}/api/auth/v2/refresh`);
        http.expectOne(`${backends.auth}/api/auth/v2/logout/retry`).flush({}, {status: 401, statusText: 'Unauthorized'});
        expect(failed).toBe(true);
        http.expectNone(`${backends.auth}/api/auth/v2/logout`);
    });

    it('retains the current token on the revoke request and clears it locally before completion', () => {
        service.acceptToken({browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: jwt('a'), expires_in: 900});
        let completed = false;
        service.logout().subscribe(() => completed = true);
        const request = http.expectOne(`${backends.auth}/api/auth/v2/logout`);
        expect(request.request.method).toBe('POST');
        expect(request.request.withCredentials).toBe(true);
        expect(request.request.headers.get('Authorization')).toBe(`Bearer ${jwt('a')}`);
        expect(service.token.value).toBeNull();
        expect(completed).toBe(false);
        request.flush(null);
        expect(completed).toBe(true);
    });

    it('updates account profile fields through the authenticated profile endpoint', () => {
        let updatedProfile: unknown;
        service.updateProfile({alert_mode: 'sounds'}).subscribe(profile => updatedProfile = profile);
        const request = http.expectOne(`${backends.auth}/api/auth/me`);
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({alert_mode: 'sounds'});
        request.flush({id: 'user-1', email: 'person@example.test', display_name: 'Person', retention_period: '30 days', alert_mode: 'sounds'});
        expect(updatedProfile).toEqual(expect.objectContaining({alert_mode: 'sounds'}));
    });

    it('routes activation verification through the configured auth service in every build', () => {
        expect(backends.activation).toBe(`${backends.auth}/api/auth/activate`);
        expect(productionBackends.activation).toBe(`${productionBackends.auth}/api/auth/activate`);
    });

    it('patches the account media preference through the typed profile endpoint', () => {
        service.updateProfile({auto_load_approved_media: false}).subscribe(profile => {
            expect(profile.auto_load_approved_media).toBe(false);
        });
        const request = http.expectOne(`${backends.auth}/api/auth/me`);
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({auto_load_approved_media: false});
        request.flush({id: 'u', email: 'u@example.test', display_name: 'User', retention_period: '30d', auto_load_approved_media: false});
    });

    it('reads media policy with the auth service contract', () => {
        service.mediaPolicy().subscribe(policy => expect(policy).toEqual({giphy_enabled: true}));
        const request = http.expectOne(`${backends.auth}/api/auth/media-policy`);
        expect(request.request.method).toBe('GET');
        request.flush({giphy_enabled: true});
    });
});
