import { z } from "zod";

import { WEBAPP_URL } from "@calcom/lib/constants";
import { defaultAvatarSrc } from "@calcom/lib/defaultAvatarImage";
import { _UserModel as User } from "@calcom/prisma/zod";
import type { inferRouterOutputs } from "@calcom/trpc";
import { TRPCError } from "@calcom/trpc";
import { authedAdminProcedure, middleware, router } from "@calcom/trpc/server/trpc";

export type UserAdminRouter = typeof userAdminRouter;
export type UserAdminRouterOutputs = inferRouterOutputs<UserAdminRouter>;

const userIdSchema = z.object({ userId: z.coerce.number() });

const userBodySchema = User.pick({
  name: true,
  email: true,
  username: true,
  bio: true,
  timeZone: true,
  weekStart: true,
  theme: true,
  defaultScheduleId: true,
  locale: true,
  timeFormat: true,
  // brandColor: true,
  // darkBrandColor: true,
  allowDynamicBooking: true,
  // away: true,
  role: true,
  // @note: disallowing avatar changes via API for now. We can add it later if needed. User should upload image via UI.
  // avatar: true,
});

/** This helps to prevent reaching the 4MB payload limit by avoiding base64 and instead passing the avatar url */
export function getAvatarUrlFromUser(user: {
  avatar: string | null;
  username: string | null;
  email: string;
}) {
  if (!user.avatar || !user.username) return defaultAvatarSrc({ email: user.email });
  return `${WEBAPP_URL}/${user.username}/avatar.png`;
}

/** @see https://www.prisma.io/docs/concepts/components/prisma-client/excluding-fields#excluding-the-password-field */
function exclude<UserType, Key extends keyof UserType>(user: UserType, keys: Key[]): Omit<UserType, Key> {
  for (const key of keys) {
    delete user[key];
  }
  return user;
}

/** Reusable logic that checks for admin permissions and if the requested user exists */
const authedAdminWithUserMiddleware = middleware(async ({ ctx, next, rawInput }) => {
  const { prisma } = ctx;
  const parsed = userIdSchema.safeParse(rawInput);
  if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: "User id is required" });
  const { userId: id } = parsed.data;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
  return next({
    ctx: {
      user: ctx.user,
      requestedUser:
        /** Don't leak the password */
        exclude(user, ["password"]),
    },
  });
});

const authedAdminProcedureWithRequestedUser = authedAdminProcedure.use(authedAdminWithUserMiddleware);

export const userAdminRouter = router({
  get: authedAdminProcedureWithRequestedUser.input(userIdSchema).query(async ({ ctx }) => {
    const { requestedUser } = ctx;
    return { user: requestedUser };
  }),
  // validate 3 optional input properties: search, skip & take (for pagination)
  list: authedAdminProcedure
    .input(
      z.object({
        search: z.string().optional(),
        skip: z.number().int().min(0).optional(),
        take: z.number().int().min(1).max(40).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { prisma } = ctx;
      const { search, skip, take } = input;

      // search_user object to filter users by search param
      const search_user = search
        ? {
            OR: [{ username: { contains: search } }, { email: { contains: search } }],
          }
        : undefined;

      const users = await prisma.user.findMany({
        where: search_user,
        skip,
        take,
      });
      return users.map((user) => ({
        /** Don't leak the password */
        ...exclude(user, ["password"]),
        /**
         * FIXME: This should be either a prisma extension or middleware
         * @see https://www.prisma.io/docs/concepts/components/prisma-client/middleware
         * @see https://www.prisma.io/docs/concepts/components/prisma-client/client-extensions/result
         **/
        avatar: getAvatarUrlFromUser(user),
      }));
    }),
  add: authedAdminProcedure.input(userBodySchema).mutation(async ({ ctx, input }) => {
    const { prisma } = ctx;
    const user = await prisma.user.create({ data: input });
    return { user, message: `User with id: ${user.id} added successfully` };
  }),
  update: authedAdminProcedureWithRequestedUser
    .input(userBodySchema.partial())
    .mutation(async ({ ctx, input }) => {
      const { prisma, requestedUser } = ctx;
      const user = await prisma.user.update({ where: { id: requestedUser.id }, data: input });
      return { user, message: `User with id: ${user.id} updated successfully` };
    }),
  delete: authedAdminProcedureWithRequestedUser.input(userIdSchema).mutation(async ({ ctx }) => {
    const { prisma, requestedUser } = ctx;
    await prisma.user.delete({ where: { id: requestedUser.id } });
    return { message: `User with id: ${requestedUser.id} deleted successfully` };
  }),
});
