import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {RegistrationModel} from './registration.model';
import {RegistrationService} from './registration.service';
import {backends} from '../../environments/environment';

describe('RegistrationService', () => {
    let service: RegistrationService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({imports: [HttpClientTestingModule], providers: [RegistrationService]});
        service = TestBed.inject(RegistrationService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('sends registration with credentials and returns only the access-token response', () => {
        const received = vi.fn().mockName('received');
        const requestModel = new RegistrationModel('invitee@example.test', 'password123', 'Invitee', 'device-1', 'invite-code');
        service.registration(requestModel).subscribe(received);

        const request = http.expectOne(backends.registration);
        expect(request.request.method).toBe('POST');
        expect(request.request.withCredentials).toBe(true);
        expect(request.request.body).toEqual(requestModel);

        const response = {token_type: 'Bearer', access_token: 'memory-only-access-token', expires_in: 300};
        request.flush(response);

        expect(received).toHaveBeenCalledWith(response);
        expect(JSON.stringify(received.mock.calls)).not.toContain('refresh_token');
    });
});
