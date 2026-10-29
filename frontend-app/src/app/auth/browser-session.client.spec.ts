import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {BrowserSessionClient} from './browser-session.client';
import {AuthCookieLockService} from './auth-cookie-lock.service';

describe('BrowserSessionClient', () => {
    const endpoints = {discover: '/v2/discover', continue: '/v2/continue'};
    let client: BrowserSessionClient;
    let http: HttpTestingController;

    beforeEach(() => {
        vi.stubGlobal('navigator', {});
        TestBed.configureTestingModule({imports: [HttpClientTestingModule], providers: [
            {provide: AuthCookieLockService, useValue: {run: (work: () => unknown) => work()}},
        ]});
        client = TestBed.inject(BrowserSessionClient);
        http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => { http.verify(); vi.unstubAllGlobals(); });

    it('discovers candidates without automatically continuing even for one candidate', () => {
        let name = '';
        client.discover(endpoints).subscribe(result => name = result.candidates[0].display_name);
        const discovery = http.expectOne(endpoints.discover);
        expect(discovery.request.withCredentials).toBe(true);
        expect(discovery.request.body).toEqual({});
        discovery.flush({candidates: [{browser_id: 'browser', generation: 'generation', display_name: 'Alice'}]});
        expect(name).toBe('Alice');
        http.expectNone(endpoints.continue);
    });

    it('continues only the explicitly selected nonsecret identifiers using cookies', () => {
        client.continue(endpoints, {browser_id: 'browser', generation: 'generation'}).subscribe();
        const request = http.expectOne(endpoints.continue);
        expect(request.request.withCredentials).toBe(true);
        expect(request.request.body).toEqual({browser_id: 'browser', generation: 'generation'});
        request.flush({browser_id: 'browser', generation: 'next', access_token: 'access', token_type: 'Bearer', expires_in: 900});
    });
});
