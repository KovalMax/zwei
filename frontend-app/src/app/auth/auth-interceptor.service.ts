import {Injectable} from '@angular/core';
import {HttpHandler, HttpHeaders, HttpInterceptor, HttpRequest} from '@angular/common/http';
import {catchError, exhaustMap, take} from 'rxjs/operators';
import {HttpErrorResponse} from '@angular/common/http';
import {Router} from '@angular/router';
import {throwError} from 'rxjs';

import {AuthService} from './auth.service';

@Injectable()
export class AuthInterceptorService implements HttpInterceptor {
    constructor(private authService: AuthService, private router: Router) {
    }

    intercept(req: HttpRequest<any>, next: HttpHandler) {
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
                ).pipe(catchError((error: HttpErrorResponse) => {
                    if (error.status === 401) {
                        this.authService.logout(false);
                        if (!req.url.includes('/login') && !req.url.includes('/register')) {
                            void this.router.navigate(['/login']);
                        }
                    }
                    return throwError(() => error);
                }));
            })
        );
    }
}
