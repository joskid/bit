import { BuildContext } from '@teambit/builder';
import { Capsule } from '@teambit/isolator';
import { ExecutionContext } from '@teambit/environments';

export type Target = {
  /**
   * entries of the target.
   */
  entries: string[];

  /**
   * root path of the target
   */
  capsule: Capsule;
};

export interface BundlerContext extends BuildContext {
  targets: Target[];
}

export interface DevServerContext extends ExecutionContext {
  entry: string[];
}
