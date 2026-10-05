import {HttpErrorResponse, HttpRequest, HttpResponse} from '@angular/common/http';
import {DefaultUrlSerializer} from '@angular/router';
import {of, throwError} from 'rxjs';

import {AuthInterceptorService} from './auth-interceptor.service';

describe('AuthInterceptorService connectivity confirmation', () => {
    const pwa = {confirmNetworkResponse: vi.fn()};
    const auth = {
        token: of(null),
        logout: vi.fn(),
    };
    const urlSerializer = new DefaultUrlSerializer();
    const router = {
        url: '/home',
        navigate: vi.fn().mockResolvedValue(true),
        parseUrl: (url: string) => urlSerializer.parse(url),
    };
    const host = {authEndpoint: vi.fn(() => 'https://chat.localhost/api/auth/refresh')};
    let interceptor: AuthInterceptorService;

    beforeEach(() => {
        vi.clearAllMocks();
        interceptor = new AuthInterceptorService(auth as never, router as never, pwa as never, host as never);
    });

    it('confirms connectivity for a successful HTTP response', () => {
        const request = new HttpRequest('GET', '/api/status');
        const handler = {handle: vi.fn().mockReturnValue(of(new HttpResponse({status: 200})))};

        interceptor.intercept(request, handler).subscribe();

        expect(pwa.confirmNetworkResponse).toHaveBeenCalledOnce();
    });

    it('confirms connectivity for real HTTP errors, but not service-worker timeouts or network failures', () => {
        const request = new HttpRequest('GET', '/api/status');
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 404})))};

        interceptor.intercept(request, handler).subscribe({error: () => undefined});
        expect(pwa.confirmNetworkResponse).toHaveBeenCalledOnce();

        pwa.confirmNetworkResponse.mockClear();
        const timeoutHandler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 504})))};
        interceptor.intercept(request, timeoutHandler).subscribe({error: () => undefined});
        expect(pwa.confirmNetworkResponse).not.toHaveBeenCalled();

        const offlineHandler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 0})))};
        interceptor.intercept(request, offlineHandler).subscribe({error: () => undefined});
        expect(pwa.confirmNetworkResponse).not.toHaveBeenCalled();
    });

    it('does not navigate for a refresh 401 when Router.url is still the previous route', () => {
        router.url = '/';
        const request = new HttpRequest('POST', '/api/auth/refresh', {});
        const unauthorized = new HttpErrorResponse({status: 401});
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => unauthorized))};
        let receivedError: unknown;

        interceptor.intercept(request, handler).subscribe({error: error => receivedError = error});

        expect(auth.logout).toHaveBeenCalledOnce();
        expect(auth.logout).toHaveBeenCalledWith(false);
        expect(router.navigate).not.toHaveBeenCalled();
        expect(receivedError).toBe(unauthorized);
    });

    it('does not treat the same refresh path on a different origin as the configured endpoint', () => {
        router.url = '/home';
        const request = new HttpRequest('GET', 'https://other.example/api/auth/refresh');
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 401})))};

        interceptor.intercept(request, handler).subscribe({error: () => undefined});

        expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('redirects a protected route to login after a 401', () => {
        router.url = '/home';
        const request = new HttpRequest('GET', '/api/home');
        const handler = {handle: vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({status: 401})))};

        interceptor.intercept(request, handler).subscribe({error: () => undefined});

        expect(auth.logout).toHaveBeenCalledOnce();
        expect(auth.logout).toHaveBeenCalledWith(false);
        expect(router.navigate).toHaveBeenCalledOnce();
        expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });
});
