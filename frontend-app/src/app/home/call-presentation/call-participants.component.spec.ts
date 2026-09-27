import {ComponentFixture, TestBed} from '@angular/core/testing';
import {AppModule} from '../../app.module';
import {HomeModule} from '../home.module';
import {CallParticipantsComponent} from './call-participants.component';

describe('CallParticipantsComponent', () => {
    let fixture: ComponentFixture<CallParticipantsComponent>;
    let component: CallParticipantsComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [AppModule, HomeModule]}).compileComponents();
        fixture = TestBed.createComponent(CallParticipantsComponent);
        component = fixture.componentInstance;
    });

    it('tracks participant DOM by stable user/device identity', () => {
        const participant = {id: 'user-1:device-1', name: 'Member'};
        expect(component.trackParticipant(0, participant)).toBe(participant.id);
    });
});
