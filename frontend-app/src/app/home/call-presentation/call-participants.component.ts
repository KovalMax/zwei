import {ChangeDetectionStrategy, Component, Input} from '@angular/core';
import {CallPresentationParticipants} from '../call-presentation.model';

@Component({
    standalone: false,
    selector: 'app-call-participants',
    templateUrl: './call-participants.component.html',
    styleUrls: ['./call-participants.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallParticipantsComponent {
    @Input({required: true}) public participants: readonly CallPresentationParticipants[] = [];

    public trackParticipant(_index: number, participant: CallPresentationParticipants): string { return participant.id; }
}
