import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {RegistrationModel} from './registration.model';
import {RegistrationService} from './registration.service';
import {backends} from '../../environments/environment';
import {HostService} from '../auth/host.service';

describe('RegistrationService', () => {
    let service: RegistrationService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({imports: [HttpClientTestingModule], providers: [RegistrationService]});
        service = TestBed.inject(RegistrationService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => {
        localStorage.removeItem('zwei.pending-logout');
        vi.unstubAllGlobals();
        http.verify();
    });

    it('does not send an invitation registration while sign out is pending', async () => {
        localStorage.setItem('zwei.pending-logout', '{}');
        const failed = vi.fn();
        service.registration(new RegistrationModel('user@example.test', 'password123', 'User', 'device', 'invite')).subscribe({error: failed});
        await vi.waitFor(() => expect(failed).toHaveBeenCalled());
        http.expectNone(`${backends.auth}/api/auth/v2/register`);
    });

    it('rechecks pending sign out after waiting for the cookie lock', async () => {
        let grant: (() => Promise<void>) | undefined;
        vi.stubGlobal('navigator', {locks: {request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
            grant = callback;
            return new Promise<void>(() => undefined);
        }}});
        const failed = vi.fn();
        service.registration(new RegistrationModel('user@example.test', 'password123', 'User', 'device', 'invite')).subscribe({error: failed});
        expect(grant).toBeDefined();
        localStorage.setItem('zwei.pending-logout', '{}');
        void grant?.();
        await vi.waitFor(() => expect(failed).toHaveBeenCalled());
        http.expectNone(`${backends.auth}/api/auth/v2/register`);
    });

    it('sends registration with credentials and returns only the access-token response', async () => {
        const received = vi.fn().mockName('received');
        const requestModel = new RegistrationModel('invitee@example.test', 'password123', 'Invitee', 'device-1', 'invite-code');
        service.registration(requestModel).subscribe(received);

        const request = await vi.waitFor(() => http.expectOne(`${backends.auth}/api/auth/v2/register`));
        expect(request.request.method).toBe('POST');
        expect(request.request.withCredentials).toBe(true);
        expect(request.request.body).toEqual(requestModel);

        const response = {browser_id: 'browser', generation: 'one', token_type: 'Bearer', access_token: 'memory-only-access-token', expires_in: 300};
        request.flush(response);

        await vi.waitFor(() => expect(received).toHaveBeenCalledWith(response));
        expect(JSON.stringify(received.mock.calls)).not.toContain('refresh_token');
    });

    it('uses the v2 endpoint and returns pending without a session', async () => {
        const host = TestBed.inject(HostService);
        vi.spyOn(host, 'browserSessionEndpoint').mockReturnValue('/api/auth/v2/register');
        const received = vi.fn();
        service.registration(new RegistrationModel('user@example.test', 'password123', 'User', 'device')).subscribe(received);
        const request = await vi.waitFor(() => http.expectOne('/api/auth/v2/register'));
        expect(request.request.withCredentials).toBe(true);
        request.flush({status: 'pending'}, {status: 202, statusText: 'Accepted'});
        await vi.waitFor(() => expect(received).toHaveBeenCalledWith({status: 'pending'}));
    });

    it('accepts only a complete v2 invitation session and strips unexpected fields', async () => {
        const host = TestBed.inject(HostService);
        vi.spyOn(host, 'browserSessionEndpoint').mockReturnValue('/api/auth/v2/register');
        const received = vi.fn();
        service.registration(new RegistrationModel('user@example.test', 'password123', 'User', 'device', 'invite')).subscribe(received);
        const request = await vi.waitFor(() => http.expectOne('/api/auth/v2/register'));
        request.flush({browser_id: 'browser', generation: 'generation', token_type: 'Bearer', access_token: 'access', expires_in: 300, refresh_token: 'unexpected'}, {status: 201, statusText: 'Created'});
        await vi.waitFor(() => expect(received).toHaveBeenCalledWith({browser_id: 'browser', generation: 'generation', token_type: 'Bearer', access_token: 'access', expires_in: 300}));
    });

    it('rejects a v2 session without selectors', async () => {
        const host = TestBed.inject(HostService);
        vi.spyOn(host, 'browserSessionEndpoint').mockReturnValue('/api/auth/v2/register');
        const failed = vi.fn();
        service.registration(new RegistrationModel('user@example.test', 'password123', 'User', 'device', 'invite')).subscribe({error: failed});
        const request = await vi.waitFor(() => http.expectOne('/api/auth/v2/register'));
        request.flush({token_type: 'Bearer', access_token: 'access', expires_in: 300});
        await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    });

    it('rejects a session response for ordinary registration', async () => {
        const host = TestBed.inject(HostService);
        vi.spyOn(host, 'browserSessionEndpoint').mockReturnValue('/api/auth/v2/register');
        const failed = vi.fn();
        service.registration(new RegistrationModel('user@example.test', 'password123', 'User', 'device')).subscribe({error: failed});
        const request = await vi.waitFor(() => http.expectOne('/api/auth/v2/register'));
        request.flush({browser_id: 'browser', generation: 'generation', token_type: 'Bearer', access_token: 'access', expires_in: 300});
        await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    });
});
