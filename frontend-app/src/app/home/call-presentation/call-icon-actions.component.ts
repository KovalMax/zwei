import {ChangeDetectionStrategy, Component, EventEmitter, Input, Output} from '@angular/core';
import {CallPresentationAction, CallPresentationActionID} from '../call-presentation.model';
import {ZweiIconName} from '../../shared/zwei-icon/zwei-icon.component';

@Component({
    standalone: false,
    selector: 'app-call-icon-actions',
    templateUrl: './call-icon-actions.component.html',
    styleUrls: ['./call-icon-actions.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallIconActionsComponent {
    @Input({required: true}) public actions: readonly CallPresentationAction[] = [];
    @Output() public readonly action = new EventEmitter<CallPresentationActionID>();

    public trackAction(_index: number, item: CallPresentationAction): CallPresentationAction['id'] { return item.id; }
    public screenShareIcon(item: CallPresentationAction): ZweiIconName { return item.active ? 'stop_screen_share' : 'screen_share'; }
    public mutePath(item: CallPresentationAction): string {
        return item.active
            ? 'm19.3 17.9 1.4-1.4-14-14-1.4 1.4 4.1 4.1V11a3 3 0 0 0 4.8 2.4l2.1 2.1A5.3 5.3 0 0 1 8.7 11a1 1 0 0 0-2 0 5.3 5.3 0 0 0 4.3 5.2V19H8a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2h-3v-2.8c.8-.2 1.5-.5 2.1-.9l2.8 2.6zM12 3a3 3 0 0 0-2.8 4.1l5.7 5.7A3 3 0 0 0 15 11V5a3 3 0 0 0-3-2z'
            : 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3a1 1 0 0 0-2 0 3.3 3.3 0 0 1-6.6 0 1 1 0 0 0-2 0 5.3 5.3 0 0 0 4.3 5.2V19H8a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2h-3v-2.8a5.3 5.3 0 0 0 4.3-5.2z';
    }
}
