import {TestBed} from '@angular/core/testing';
import {SwUpdate} from '@angular/service-worker';
import {Subject} from 'rxjs';

import {PwaService} from './pwa.service';

describe('PwaService', () => {
    const versionUpdates = new Subject<any>();
    const updates = {
        isEnabled: false,
        versionUpdates,
        activateUpdate: jasmine.createSpy('activateUpdate').and.resolveTo(true),
    };

    beforeEach(() => {
        TestBed.configureTestingModule({providers: [{provide: SwUpdate, useValue: updates}]});
        updates.isEnabled = false;
        updates.activateUpdate.calls.reset();
    });

    it('offers installation only after authentication and consumes the deferred prompt', async () => {
        const service = TestBed.inject(PwaService);
        const prompt = jasmine.createSpy('prompt').and.resolveTo();
        const event = new Event('beforeinstallprompt') as Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'accepted'}>};
        Object.assign(event, {prompt, userChoice: Promise.resolve({outcome: 'accepted'})});

        window.dispatchEvent(event);
        expect(service.canInstall).toBeFalse();

        service.setAuthenticated(true);
        expect(service.canInstall).toBeTrue();
        await service.install();

        expect(prompt).toHaveBeenCalled();
        expect(service.canInstall).toBeFalse();
    });

    it('only activates an available update after an authenticated user selects it', async () => {
        updates.isEnabled = true;
        updates.activateUpdate.and.resolveTo(false);
        const service = TestBed.inject(PwaService);
        versionUpdates.next({type: 'VERSION_READY'});
        expect(service.updateAvailable).toBeTrue();

        await service.applyUpdate();
        expect(updates.activateUpdate).not.toHaveBeenCalled();

        service.setAuthenticated(true);
        await service.applyUpdate();
        expect(updates.activateUpdate).toHaveBeenCalledTimes(1);
    });

    it('publishes offline and online transitions', () => {
        const service = TestBed.inject(PwaService);

        window.dispatchEvent(new Event('offline'));
        expect(service.isOffline).toBeTrue();

        window.dispatchEvent(new Event('online'));
        expect(service.isOffline).toBeFalse();
    });
});
