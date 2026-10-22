import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { backends } from '../../environments/environment';
import { backends as productionBackends } from '../../environments/environment.prod';
import { AuthService } from './auth.service';

describe('AuthService', () => {
    let service: AuthService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
        service = TestBed.inject(AuthService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('shares one refresh request and reuses an unauthenticated result', () => {
        const results: Array<string | null> = [];

        service.restore().subscribe(token => results.push(token?.access_token || null));
        service.restore().subscribe(token => results.push(token?.access_token || null));

        const request = http.expectOne(backends.refresh);
        expect(request.request.withCredentials).toBe(true);
        request.flush({ error: 'invalid refresh token' }, { status: 401, statusText: 'Unauthorized' });

        service.restore().subscribe(token => results.push(token?.access_token || null));

        expect(results).toEqual([null, null, null]);
    });

    it('accepts a token issued by registration into memory', () => {
        service.acceptToken({ token_type: 'Bearer', access_token: 'registered-access', expires_in: 900 });

        expect(service.token.value?.access_token).toBe('registered-access');
        expect(service.token.value?.expires_in).toBeGreaterThan(Date.now());
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
