import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';

import {backends} from '../../environments/environment';
import {AuthService} from './auth.service';

describe('AuthService', () => {
    let service: AuthService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({imports: [HttpClientTestingModule]});
        service = TestBed.inject(AuthService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('shares one refresh request and reuses an unauthenticated result', () => {
        const results: Array<string | null> = [];

        service.restore().subscribe(token => results.push(token?.access_token || null));
        service.restore().subscribe(token => results.push(token?.access_token || null));

        const request = http.expectOne(backends.refresh);
        expect(request.request.withCredentials).toBeTrue();
        request.flush({error: 'invalid refresh token'}, {status: 401, statusText: 'Unauthorized'});

        service.restore().subscribe(token => results.push(token?.access_token || null));

        expect(results).toEqual([null, null, null]);
    });
});
