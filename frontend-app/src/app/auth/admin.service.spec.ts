import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';

import {AdminService} from './admin.service';

describe('AdminService', () => {
    let service: AdminService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({imports: [HttpClientTestingModule]});
        service = TestBed.inject(AdminService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('posts to the resend activation endpoint', () => {
        service.resendActivationLink('user-1').subscribe();

        const request = http.expectOne(item => item.url.endsWith('/api/admin/users/user-1/resend-activation'));
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual({});
        request.flush(null);
    });
});
