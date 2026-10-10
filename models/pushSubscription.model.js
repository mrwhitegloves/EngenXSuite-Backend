import mongoose from 'mongoose';

// One browser on one device that a user allowed to show notifications (browser push).
// A user can have several: the laptop, the phone. Schema only: no methods (decision 0005).

const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // The address the browser's push service gave this browser. It identifies the subscription.
    endpoint: { type: String, required: true, unique: true, maxlength: 1000 },
    // The browser's keys: a push is encrypted with them, so only that browser can read it.
    keys: {
      p256dh: { type: String, required: true, maxlength: 300 },
      auth: { type: String, required: true, maxlength: 100 },
    },
    // Which browser it is, as the browser names itself; shown so a person can tell them apart.
    userAgent: { type: String, maxlength: 300 },
    lastUsedAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

pushSubscriptionSchema.index({ userId: 1 });

export const PushSubscription =
  mongoose.models.PushSubscription ??
  mongoose.model('PushSubscription', pushSubscriptionSchema, 'push_subscriptions');
