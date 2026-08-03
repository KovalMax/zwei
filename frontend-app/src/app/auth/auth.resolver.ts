import {Injectable} from '@angular/core';
import {ActivatedRouteSnapshot, Resolve, Router, RouterStateSnapshot} from '@angular/router';
import {AuthService} from './auth.service';
import {Observable} from 'rxjs';
import {map} from 'rxjs/operators';

@Injectable({providedIn: 'root'})
export class AuthResolver implements Resolve<boolean> {
    constructor(
        private router: Router,
        private authService: AuthService
    ) {
    }

    resolve(route: ActivatedRouteSnapshot, state: RouterStateSnapshot): Observable<any> {
        return this.authService.restore().pipe(
            map(token => {
                const isAuth = token && token.access_token;
                if (!isAuth) {
                    return true;
                }

                return this.router.navigate(['home']);
            })
        );
    }
}
