import {ActivatedRouteSnapshot, CanActivate, Router, RouterStateSnapshot, UrlTree} from '@angular/router';
import {Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {map} from 'rxjs/operators';

import {AuthService} from './auth.service';

@Injectable({providedIn: 'root'})
export class AuthGuard implements CanActivate {
    constructor(private authService: AuthService, private router: Router) {
    }

    public canActivate(route: ActivatedRouteSnapshot, router: RouterStateSnapshot): Observable<boolean | UrlTree> {
        return this.authService.restore().pipe(
            map(token => {
                const isAuth = token && token.access_token;
                if (isAuth) {
                    return true;
                }

                return this.router.createUrlTree(['login']);
            })
        );
    }
}
