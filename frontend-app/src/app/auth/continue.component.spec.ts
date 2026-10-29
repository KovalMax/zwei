import {CommonModule} from '@angular/common';
import {provideZonelessChangeDetection} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {RouterModule} from '@angular/router';
import {of, Subject, throwError} from 'rxjs';
import {AuthService} from './auth.service';
import {BrowserSessionClient} from './browser-session.client';
import {ContinueComponent} from './continue.component';
import {HostService} from './host.service';

describe('ContinueComponent', () => {
    const candidate = {browser_id: 'one', generation: 'generation', display_name: 'Alice'};
    const session = {...candidate, access_token: 'access', token_type: 'Bearer', expires_in: 900};
    let client: {discover: ReturnType<typeof vi.fn>; continue: ReturnType<typeof vi.fn>};
    let auth: {acceptToken: ReturnType<typeof vi.fn>; defaultAuthenticatedRoute: () => string};
    let router: {navigate: ReturnType<typeof vi.fn>};
    let component: ContinueComponent;

    beforeEach(() => {
        client = {discover: vi.fn(() => of({candidates: [candidate]})), continue: vi.fn(() => of(session))};
        auth = {acceptToken: vi.fn(), defaultAuthenticatedRoute: () => 'home'};
        router = {navigate: vi.fn()};
        component = new ContinueComponent(client as never, auth as never, {browserSessionEndpoints: () => ({discover: '/discover', continue: '/continue'})} as never, router as never, {markForCheck: () => {}} as never);
    });

    it('requires an explicit choice even for one session', () => {
        component.ngOnInit();
        expect(component.candidates).toEqual([candidate]);
        expect(client.continue).not.toHaveBeenCalled();
        component.continue(candidate);
        expect(client.continue).toHaveBeenCalledWith({discover: '/discover', continue: '/continue'}, candidate);
        expect(auth.acceptToken).toHaveBeenCalledWith(session);
        expect(router.navigate).toHaveBeenCalledWith(['home']);
    });

    it('does not accept a token on stale selection and allows rediscovery', () => {
        client.continue.mockReturnValue(throwError(() => ({status: 401})));
        component.ngOnInit();
        component.continue(candidate);
        expect(auth.acceptToken).not.toHaveBeenCalled();
        expect(component.error).toContain('Could not continue');
        component.discover();
        expect(component.candidates).toEqual([candidate]);
    });

    it('reports a storage failure without navigating', () => {
        auth.acceptToken.mockImplementation(() => { throw new Error('storage unavailable'); });
        component.ngOnInit();
        component.continue(candidate);
        expect(component.loading).toBe(false);
        expect(component.error).toContain('Could not continue');
        expect(router.navigate).not.toHaveBeenCalled();
    });
});

describe('ContinueComponent rendered discovery', () => {
    it('renders a saved session when discovery completes asynchronously', async () => {
        const discovery = new Subject<{candidates: {browser_id: string; generation: string; display_name: string}[]}>();
        await TestBed.configureTestingModule({
            declarations: [ContinueComponent],
            imports: [CommonModule, RouterModule.forRoot([])],
            providers: [
                provideZonelessChangeDetection(),
                {provide: BrowserSessionClient, useValue: {discover: () => discovery}},
                {provide: AuthService, useValue: {}},
                {provide: HostService, useValue: {browserSessionEndpoints: () => ({})}},
            ],
        }).compileComponents();
        const fixture = TestBed.createComponent(ContinueComponent);
        await fixture.whenStable();
        expect(fixture.nativeElement.textContent).toContain('Checking your session');
        discovery.next({candidates: [{browser_id: 'one', generation: 'generation', display_name: 'Alice'}]});
        discovery.complete();
        await fixture.whenStable();
        expect(fixture.nativeElement.textContent).toContain('Continue as Alice');
        expect(fixture.nativeElement.textContent).not.toContain('Checking your session');
    });
});
