import { z } from 'zod';

export const searchQuery = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
});
