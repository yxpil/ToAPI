// @author yxpil
//2026年10月24日
import type { Db } from '../database'
import { ApiRepo } from './api.repo'
import { CollectionRepo } from './collection.repo'
import { EnvironmentRepo } from './environment.repo'
import { HistoryRepo } from './history.repo'
import { NotificationRepo } from './notification.repo'
import { OpenLogRepo } from './open-log.repo'
import { ProjectRepo } from './project.repo'
import { RunnerRepo } from './runner.repo'
import { ScheduleRepo } from './schedule.repo'
import { SettingsRepo } from './settings.repo'
import { SourceMetaRepo } from './source.repo'
import { VariableRepo } from './variable.repo'

export interface Repos {
  project: ProjectRepo
  collection: CollectionRepo
  api: ApiRepo
  environment: EnvironmentRepo
  variable: VariableRepo
  history: HistoryRepo
  runner: RunnerRepo
  source: SourceMetaRepo
  settings: SettingsRepo
  openLog: OpenLogRepo
  schedule: ScheduleRepo
  notification: NotificationRepo
}

export const createRepos = (db: Db): Repos => ({
  project: new ProjectRepo(db),
  collection: new CollectionRepo(db),
  api: new ApiRepo(db),
  environment: new EnvironmentRepo(db),
  variable: new VariableRepo(db),
  history: new HistoryRepo(db),
  runner: new RunnerRepo(db),
  source: new SourceMetaRepo(db),
  settings: new SettingsRepo(db),
  openLog: new OpenLogRepo(db),
  schedule: new ScheduleRepo(db),
  notification: new NotificationRepo(db),
})

export {
  ApiRepo,
  CollectionRepo,
  EnvironmentRepo,
  HistoryRepo,
  NotificationRepo,
  OpenLogRepo,
  ProjectRepo,
  RunnerRepo,
  ScheduleRepo,
  SettingsRepo,
  SourceMetaRepo,
  VariableRepo,
}
