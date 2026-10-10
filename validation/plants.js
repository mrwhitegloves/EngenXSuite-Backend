import { z } from 'zod';
import { DATA_AVAILABILITY, MACHINE_CRITICALITY } from '../models/machine.model.js';
import { DIGITAL_MATURITY } from '../models/plant.model.js';
import { UNIT_TYPES } from '../models/plantUnit.model.js';
import { objectId } from './common.js';

// Short free text. An empty text clears the field (null).
const text = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const address = z
  .object({
    addressLine: text(300),
    city: text(100),
    state: text(100),
    country: text(100),
    pincode: text(12),
  })
  .partial();

// A link to one of the company's contacts; null removes the link.
const contactLink = objectId.nullable();

const plantFields = {
  name: z.string().trim().min(1, 'Enter the plant name').max(120),
  location: address,
  process: text(),
  plantType: text(),
  size: text(),
  productionCapacity: text(),
  plantHeadId: contactLink,
  maintenanceHeadId: contactLink,
  productionHeadId: contactLink,
  digitalHeadId: contactLink,
  itOtContactIds: z
    .array(objectId)
    .max(20)
    .transform((ids) => [...new Set(ids)]),
  existingAutomation: text(),
  plcScada: text(),
  mesErp: text(),
  digitalMaturity: z.enum(DIGITAL_MATURITY).nullable(),
};
const optional = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()]));
const notEmpty = [(body) => Object.keys(body).length > 0, { message: 'Nothing to update' }];

export const createPlantBody = z.object({ ...optional(plantFields), name: plantFields.name });
export const updatePlantBody = z.object(optional(plantFields)).refine(...notEmpty);

const thisYear = new Date().getFullYear();
const machineFields = {
  name: z.string().trim().min(1, 'Enter the machine name').max(120),
  // The department or line it stands in; null: directly in the plant.
  unitId: objectId.nullable(),
  // "32 CNC machines" is one row with quantity 32.
  quantity: z.number().int('Use a whole number').min(1, 'At least 1').max(100000),
  machineType: text(),
  manufacturer: text(),
  model: text(),
  controller: text(),
  plc: text(),
  protocol: text(),
  yearInstalled: z
    .number()
    .int()
    .min(1900, 'Enter a year from 1900 on')
    .max(thisYear + 1, 'This year is in the future')
    .nullable(),
  criticality: z.enum(MACHINE_CRITICALITY).nullable(),
  condition: text(),
  dataAvailability: z.enum(DATA_AVAILABILITY).nullable(),
  existingSensors: z.array(z.string().trim().min(1).max(100)).max(30),
};

const unitName = z.string().trim().min(1, 'Enter a name').max(120);
export const createUnitBody = z.object({
  type: z.enum(UNIT_TYPES),
  name: unitName,
  // For a line: the department it belongs to.
  parentId: objectId.nullable().optional(),
});
export const updateUnitBody = z
  .object({ name: unitName.optional(), parentId: objectId.nullable().optional() })
  .refine(...notEmpty);

export const createMachineBody = z.object({
  ...optional(machineFields),
  name: machineFields.name,
});
export const updateMachineBody = z.object(optional(machineFields)).refine(...notEmpty);
