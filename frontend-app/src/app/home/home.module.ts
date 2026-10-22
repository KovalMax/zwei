import {CommonModule} from '@angular/common';
import {OverlayModule} from '@angular/cdk/overlay';
import {NgModule} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {RouterModule, Routes} from '@angular/router';
import {AppMaterialModule} from '../app-material.module';
import {SharedModule} from '../shared/shared.module';
import {CallDeviceControlsComponent} from './call-presentation/call-device-controls.component';
import {CallIconActionsComponent} from './call-presentation/call-icon-actions.component';
import {CallParticipantsComponent} from './call-presentation/call-participants.component';
import {CallProfileComponent} from './call-presentation/call-profile.component';
import {CallTerminalNoticeComponent} from './call-presentation/call-terminal-notice.component';
import {CallSurfaceFrameComponent} from './call-presentation/call-surface-frame.component';
import {MinimizedCallBannerComponent} from './call-presentation/minimized-call-banner.component';
import {CopySupportReferenceComponent} from './call-presentation/copy-support-reference.component';
import {DirectCallSurfaceComponent} from './call-presentation/direct-call-surface.component';
import {GroupCallSurfaceComponent} from './call-presentation/group-call-surface.component';
import {GroupMemberListComponent} from './group-member-list.component';
import {GroupRemoteAudioDirective} from './group-remote-audio.directive';
import {HomeComponent} from './home.component';
import {InlineGiphyComponent} from './inline-giphy.component';

const routes: Routes = [{path: '', component: HomeComponent}];

@NgModule({
    declarations: [
        HomeComponent,
        InlineGiphyComponent,
        CallProfileComponent,
        CallParticipantsComponent,
        CallTerminalNoticeComponent,
        CallSurfaceFrameComponent,
        MinimizedCallBannerComponent,
        CopySupportReferenceComponent,
        CallDeviceControlsComponent,
        CallIconActionsComponent,
        DirectCallSurfaceComponent,
        GroupCallSurfaceComponent,
        GroupRemoteAudioDirective,
        GroupMemberListComponent,
    ],
    exports: [CallSurfaceFrameComponent],
    imports: [
        CommonModule,
        FormsModule,
        OverlayModule,
        RouterModule.forChild(routes),
        AppMaterialModule,
        SharedModule,
    ],
})
export class HomeModule {}
