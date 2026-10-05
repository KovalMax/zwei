import {Injectable} from '@angular/core';
import {HttpEvent, HttpHandler, HttpHeaders, HttpInterceptor, HttpRequest, HttpResponse} from '@angular/common/http';
import {catchError, exhaustMap, take, tap} from 'rxjs/operators';
import {HttpErrorResponse} from '@angular/common/http';
import {PRIMARY_OUTLET, Router} from '@angular/router';
import {Observable, throwError} from 'rxjs';

import {AuthService} from './auth.service';
import {PwaService} from '../pwa/pwa.service';
import {HostService} from './host.service';

@Injectable()
export class AuthInterceptorService implements HttpInterceptor {
    constructor(
        private authService: AuthService,
        private router: Router,
        private readonly pwa: PwaService,
        private readonly host: HostService,
    ) {
    }

    intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
        return this.authService.token.pipe(
            take(1),
            exhaustMap(token => {
                if (!token) {
                    return next.handle(req);
                }

                return next.handle(
                    req.clone({
                        headers: new HttpHeaders().set(
                            'Authorization',
                            token.token_type.concat(' ', token.access_token)
                        )
                    })
                );
            }),
            tap(event => {
                if (event instanceof HttpResponse && event.status > 0) this.pwa.confirmNetworkResponse();
            }),
            catchError((error: HttpErrorResponse) => {
                // A 504 can be synthesized by Angular's service worker when an
                // offline API request has no cached response; it is not proof
                // that the network is reachable.
                if (error.status > 0 && error.status !== 504) this.pwa.confirmNetworkResponse();
                if (error.status === 401) {
                    this.authService.logout(false);
                    if (!this.isRefreshRequest(req.url) && !req.url.includes('/login') && !req.url.includes('/register') && !this.isPublicAuthRoute()) {
                        void this.router.navigate(['/login']);
                    }
                }
                return throwError(() => error);
            })
        );
    }

    private isPublicAuthRoute(): boolean {
        const primarySegments = this.router.parseUrl(this.router.url).root.children[PRIMARY_OUTLET]?.segments ?? [];
        const route = primarySegments.map(segment => segment.path).join('/');

        return ['login', 'sign-up', 'pending', 'activate'].includes(route);
    }

    private isRefreshRequest(requestUrl: string): boolean {
        try {
            const configured = new URL(this.host.authEndpoint('refresh'), window.location.origin);
            const request = new URL(requestUrl, window.location.origin);
            const requestHasAuthority = /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(requestUrl);

            return request.pathname === configured.pathname && (!requestHasAuthority || request.origin === configured.origin);
        } catch {
            return false;
        }
    }
}
