import {ComponentFixture, TestBed} from '@angular/core/testing';
import {AppModule} from '../../app.module';
import {HomeModule} from '../home.module';
import {CallDeviceControlsComponent} from './call-device-controls.component';

describe('CallDeviceControlsComponent', () => {
    let fixture: ComponentFixture<CallDeviceControlsComponent>;
    let component: CallDeviceControlsComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [AppModule, HomeModule]}).compileComponents();
        fixture = TestBed.createComponent(CallDeviceControlsComponent);
        component = fixture.componentInstance;
    });

    it('emits only typed selectable device intent', () => {
        const controlChange = jasmine.createSpy('controlChange');
        component.controls = [{id: 'microphone', label: 'Microphone input', value: 'mic-1', options: [{id: 'mic-1', label: 'Studio microphone'}], disabled: false}];
        component.controlChange.subscribe(controlChange);
        fixture.detectChanges();

        component.select('microphone', 'unknown');
        component.select('microphone', 'mic-1');

        expect(controlChange).toHaveBeenCalledOnceWith({id: 'microphone', value: 'mic-1'});
    });

    it('tracks frequently refreshed controls and device options by stable IDs', () => {
        const microphone = {id: 'microphone', label: 'Microphone input', value: 'mic-1', options: [{id: 'mic-1', label: 'Studio microphone'}], disabled: false} as const;
        const device = {id: 'mic-1', label: 'Studio microphone'} as const;

        expect(component.trackControl(0, microphone)).toBe('microphone');
        expect(component.trackDevice(0, device)).toBe('mic-1');
    });
});
