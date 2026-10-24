// @author yxpil
import type { Db } from '../database'
import { ApiRepo } from './api.repo'
import { CollectionRepo } from './collection.repo'
import { EnvironmentRepo } from './environment.repo'
import { HistoryRepo } from './history.repo'
import { ProjectRepo } from './project.repo'
import { RunnerRepo } from './runner.repo'
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
})

export {
  ApiRepo,
  CollectionRepo,
  EnvironmentRepo,
  HistoryRepo,
  ProjectRepo,
  RunnerRepo,
  SourceMetaRepo,
  VariableRepo,
}
