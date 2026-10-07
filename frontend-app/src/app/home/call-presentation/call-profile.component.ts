import {ChangeDetectionStrategy, Component, EventEmitter, Input, Output} from '@angular/core';
import {CallPresentationProfile} from '../call-presentation.model';

@Component({
    standalone: false,
    selector: 'app-call-profile',
    templateUrl: './call-profile.component.html',
    styleUrls: ['./call-profile.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallProfileComponent {
    @Input({required: true}) public profile: CallPresentationProfile = {name: '', status: '', error: false};
    @Input() public collapsible = false;
    @Input() public collapseLabel = 'Minimize call';
    @Output() public readonly collapse = new EventEmitter<void>();
}
