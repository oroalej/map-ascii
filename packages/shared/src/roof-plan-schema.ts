import * as z from 'zod';
import { isRoofPlan, type RoofPlan } from './roof-plan';

/** The worker's bounded guard is also the pipeline schema's source of truth. */
export const RoofPlanSchema = z.custom<RoofPlan>(isRoofPlan, 'invalid version 1 roof partition');
