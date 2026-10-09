import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { SolutionCategory } from '../models/solutionCategory.model.js';
import { runSeed, seedStartingLists } from '../seeds/seed.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const OPTIONS = { productName: 'P', companyName: 'C', workspaceDomain: 'engenx.in' };

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(clearTestDb);

describe('seed: starting lists', () => {
  it('creates the pipeline in order, ending with one Won and one Lost stage', async () => {
    const result = await seedStartingLists();
    expect(result.stagesCreated).toBe(15);

    const stages = await PipelineStage.find().sort({ order: 1 }).lean();
    expect(stages.map((stage) => stage.name)).toEqual([
      'Lead',
      'Qualified',
      'Discovery',
      'Plant Visit',
      'Requirement Identified',
      'DMA / Technical Study',
      'Solution Designing',
      'Proposal',
      'Technical Discussion',
      'Pilot / PoC',
      'Commercial Negotiation',
      'Management Approval',
      'PO Expected',
      'Won',
      'Lost',
    ]);
    expect(stages.filter((stage) => stage.type === 'won').map((stage) => stage.key)).toEqual([
      'won',
    ]);
    expect(stages.filter((stage) => stage.type === 'lost').map((stage) => stage.key)).toEqual([
      'lost',
    ]);
    // Keys are unique, and the suggested chance of winning never goes down along the open stages.
    expect(new Set(stages.map((stage) => stage.key)).size).toBe(15);
    const open = stages.filter((stage) => stage.type === 'open');
    for (let index = 1; index < open.length; index += 1) {
      expect(open[index].defaultProbability).toBeGreaterThan(open[index - 1].defaultProbability);
    }
    expect(stages.every((stage) => stage.isActive)).toBe(true);
  });

  it('creates the 16 solution categories in order', async () => {
    const result = await seedStartingLists();
    expect(result.categoriesCreated).toBe(16);
    const names = (await SolutionCategory.find().sort({ order: 1 }).lean()).map(
      (item) => item.name,
    );
    expect(names).toHaveLength(16);
    expect(names[0]).toBe('Digital Twin');
    expect(names.at(-1)).toBe('Custom Automation');
    expect(new Set(names).size).toBe(16);
  });

  it('running it again changes nothing, and never brings back what an administrator removed', async () => {
    await runSeed(OPTIONS);
    await seedStartingLists();
    await PipelineStage.updateOne({ key: 'lead' }, { $set: { name: 'New Enquiry' } });
    await PipelineStage.deleteOne({ key: 'pilot_poc' });
    await SolutionCategory.deleteOne({ name: 'OEE' });

    expect((await runSeed(OPTIONS)).rolesCreated).toEqual([]);
    expect(await seedStartingLists()).toEqual({ stagesCreated: 0, categoriesCreated: 0 });
    expect(await PipelineStage.countDocuments()).toBe(14);
    expect((await PipelineStage.findOne({ key: 'lead' }).lean()).name).toBe('New Enquiry');
    expect(await SolutionCategory.countDocuments()).toBe(15);
  });
});
