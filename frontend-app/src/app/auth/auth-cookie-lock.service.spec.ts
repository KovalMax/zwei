import {Observable, Subject} from 'rxjs';
import {AuthCookieLockService} from './auth-cookie-lock.service';

describe('AuthCookieLockService', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('rejects without starting cookie mutations when Web Locks are unavailable', () => {
        vi.stubGlobal('navigator', {});
        const request = vi.fn(() => new Subject<void>());
        let failure: unknown;
        new AuthCookieLockService().run(request).subscribe({error: error => failure = error});
        expect(request).not.toHaveBeenCalled();
        expect(failure).toEqual(expect.objectContaining({name: 'AuthCookieLockUnavailableError'}));
    });

    it('does not start a queued request after unsubscription', async () => {
        let grant: (() => Promise<unknown>) | undefined;
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
            grant = callback;
            return new Promise(() => undefined);
        }}});
        const request = vi.fn(() => new Subject<void>());
        const subscription = new AuthCookieLockService().run(request).subscribe();
        subscription.unsubscribe();
        await grant?.();
        expect(request).not.toHaveBeenCalled();
    });

    it('cancels an active request on unsubscription', async () => {
        let cancelled = false;
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback()}});
        const subscription = new AuthCookieLockService().run(() => new Observable<void>(() => () => cancelled = true)).subscribe();
        subscription.unsubscribe();
        await Promise.resolve();
        expect(cancelled).toBe(true);
    });
});
