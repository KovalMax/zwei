import {HttpClientTestingModule, HttpTestingController} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {HostService} from './host.service';

import {AdminService} from './admin.service';

describe('AdminService', () => {
    let service: AdminService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({imports: [HttpClientTestingModule], providers: [{provide: HostService, useValue: {adminEndpoint: (path: string) => `https://kyc.test${path}`}}]});
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

    it('reads and updates the reviewed GIPHY source using the enabled API contract', () => {
        service.giphyMediaSource().subscribe(value => expect(value).toEqual({enabled: true}));
        const read = http.expectOne('https://kyc.test/api/admin/media-sources/giphy');
        expect(read.request.method).toBe('GET');
        read.flush({enabled: true});

        service.updateGiphyMediaSource(false).subscribe(value => expect(value).toEqual({enabled: false}));
        const update = http.expectOne('https://kyc.test/api/admin/media-sources/giphy');
        expect(update.request.method).toBe('PUT');
        expect(update.request.body).toEqual({enabled: false});
        update.flush({enabled: false});
    });
});
