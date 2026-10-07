import {CommonModule} from '@angular/common';
import {NgModule} from '@angular/core';
import {FormsModule, ReactiveFormsModule} from '@angular/forms';
import {RouterModule, Routes} from '@angular/router';
import {AppMaterialModule} from '../app-material.module';
import {SharedModule} from '../shared/shared.module';
import {AdminComponent} from './admin.component';

const routes: Routes = [{path: '', component: AdminComponent}];

@NgModule({
    declarations: [AdminComponent],
    imports: [CommonModule, FormsModule, ReactiveFormsModule, RouterModule.forChild(routes), AppMaterialModule, SharedModule],
})
export class AdminModule {}
