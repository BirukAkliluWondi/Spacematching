import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-server';
import {
  getSession,
  saveSession,
  clearSession,
  getDraft,
  saveDraft,
  SpaceDraft,
} from '@/lib/bot-session-store';
import { verifyTelebirrPayment } from '@/lib/verify-et';
import { broadcastListingToChannel } from '@/lib/telegram-broadcast';

export async function POST(request: Request) {
  try {
    const update = await request.json();
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const rawBotUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
    const botUsername = rawBotUsername.replace('@', '');
    const appName = process.env.NEXT_PUBLIC_TELEGRAM_APP_NAME || 'roommatch';
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://cd9e-196-189-152-158.ngrok-free.app';
    const receiverPhone = process.env.TELEBIRR_RECEIVER_PHONE || '0987310978';

    // Helper to send requests to Telegram API
    const sendTelegram = async (method: string, payload: Record<string, any>) => {
      if (!botToken) return null;
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch (err) {
        console.error(`Telegram API error (${method}):`, err);
        return null;
      }
    };

    // Helper to get Admin Telegram IDs
    const getAdminIds = async (): Promise<number[]> => {
      const defaultAdminIds = [800701176, 148318506]; // @birukadiyee & @WWEHID
      try {
        const { data } = await supabaseAdmin.from('users').select('telegram_id').eq('role', 'admin');
        if (data && data.length > 0) {
          const ids = data.map((u: any) => Number(u.telegram_id)).filter((id: number) => id && id !== 8415131791);
          return ids.length > 0 ? Array.from(new Set([...ids, ...defaultAdminIds])) : defaultAdminIds;
        }
      } catch {}
      return defaultAdminIds;
    };

    // Helper to format unlocked space details message
    const sendUnlockedContactDetails = async (chatId: number, space: any) => {
      const lat = space.latitude || 9.001245;
      const lng = space.longitude || 38.784512;
      const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
      const contactTg = space.contact_telegram ? (space.contact_telegram.startsWith('@') ? space.contact_telegram : `@${space.contact_telegram}`) : 'N/A';

      const text = `
<b>✅ Order Confirmed & Contact Details Unlocked!</b>

🏠 <b>Property:</b> ${space.title}
📍 <b>Exact Address:</b> ${space.exact_address}
🗺️ <b>Google Maps Directions:</b> ${mapsUrl}

📞 <b>Owner Contact:</b> ${space.contact_name} (${space.contact_phone})
💬 <b>Telegram DM:</b> ${contactTg}

<i>Thank you for finding your room on RoomMatch Ethiopia!</i>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🗺️ Open Google Maps',
                url: mapsUrl,
              },
            ],
            [
              {
                text: '📞 Call Host Now',
                url: `tel:${space.contact_phone}`,
              },
            ],
          ],
        },
      });
    };

    // =========================================================================
    // 1. HANDLE INLINE CALLBACK QUERIES
    // =========================================================================
    if (update.callback_query) {
      const callback = update.callback_query;
      const callbackData: string = callback.data || '';
      const chatId: number = callback.message?.chat?.id || callback.from.id;

      // 1.1 Fayda Verification Callbacks
      if (callbackData.startsWith('fayda_approve:') || callbackData.startsWith('fayda_reject:')) {
        const [action, targetIdStr] = callbackData.split(':');
        const targetTelegramId = parseInt(targetIdStr, 10);
        const newStatus = action === 'fayda_approve' ? 'verified' : 'rejected';

        await supabaseAdmin
          .from('users')
          .update({
            fayda_status: newStatus,
            updated_at: new Date().toISOString(),
          })
          .eq('telegram_id', targetTelegramId);

        if (callback.id) {
          await sendTelegram('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: `Fayda ID marked as ${newStatus.toUpperCase()}`,
          });
        }

        const renterNotice = newStatus === 'verified'
          ? `<b>✅ Identity Verified!</b>\n\nYour Fayda National ID has been verified by the admin team. You can now unlock room listings on RoomMatch.`
          : `<b>❌ Verification Notice</b>\n\nYour Fayda ID submission could not be verified. Please open RoomMatch and re-upload a clear photo of your ID.`;

        await sendTelegram('sendMessage', {
          chat_id: targetTelegramId,
          text: renterNotice,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // 1.2 "I Have a Space" / Start Listing Callback
      if (callbackData === 'list_space_info' || callbackData === 'start_listing') {
        if (callback.id) {
          await sendTelegram('answerCallbackQuery', { callback_query_id: callback.id });
        }

        saveSession({
          telegram_id: chatId,
          step: 'awaiting_title',
          draft_data: {},
          updated_at: new Date().toISOString(),
        });

        const promptText = `
<b>🏠 Step 1/6: Property Title</b>

Please enter a clear title for your room or property.
<i>Example: "Cozy 1BR Apartment in Bole" or "Furnished Private Room near Kazanchis"</i>

<i>(Type /cancel at any point to stop)</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: promptText,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // 1.3 Admin Space Approval Callback
      if (callbackData.startsWith('space_approve:')) {
        const draftId = callbackData.split(':')[1];
        const draft = getDraft(draftId);

        if (!draft) {
          if (callback.id) {
            await sendTelegram('answerCallbackQuery', {
              callback_query_id: callback.id,
              text: 'Draft listing not found.',
              show_alert: true,
            });
          }
          return NextResponse.json({ ok: true });
        }

        if (draft.status !== 'pending') {
          if (callback.id) {
            await sendTelegram('answerCallbackQuery', {
              callback_query_id: callback.id,
              text: `This space is already ${draft.status.toUpperCase()}.`,
              show_alert: true,
            });
          }
          return NextResponse.json({ ok: true });
        }

        // Mark draft approved
        draft.status = 'approved';
        saveDraft(draft);

        // Insert into public.spaces
        const { data: space, error: spaceErr } = await supabaseAdmin
          .from('spaces')
          .insert({
            title: draft.title,
            description: draft.description,
            price_per_month: draft.price_per_month,
            unlock_fee: 50.00,
            neighborhood: draft.neighborhood,
            exact_address: draft.exact_address,
            contact_name: draft.homeowner_name,
            contact_phone: draft.contact_phone,
            contact_telegram: draft.homeowner_username ? `@${draft.homeowner_username}` : null,
            status: 'published',
          })
          .select('id')
          .single();

        if (spaceErr) {
          console.error('Error publishing space to database:', spaceErr);
        }

        // Upload photo to Supabase Storage spaces-public bucket & insert into public.space_images
        if (space && space.id) {
          let publicImgUrl = 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80';

          if (draft.photo_url || draft.photo_file_id) {
            try {
              let sourceUrl = draft.photo_url;
              if (!sourceUrl && draft.photo_file_id && botToken) {
                const fRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${draft.photo_file_id}`);
                const fJson = await fRes.json();
                if (fJson?.result?.file_path) {
                  sourceUrl = `https://api.telegram.org/file/bot${botToken}/${fJson.result.file_path}`;
                }
              }

              if (sourceUrl) {
                const imgRes = await fetch(sourceUrl);
                const arrayBuf = await imgRes.arrayBuffer();
                const fileName = `space_${space.id}_${Date.now()}.jpg`;

                const { data: uploadData } = await supabaseAdmin.storage
                  .from('spaces-public')
                  .upload(fileName, Buffer.from(arrayBuf), {
                    contentType: 'image/jpeg',
                    upsert: true,
                  });

                if (uploadData) {
                  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://lzatfklszrovfqoyufnt.supabase.co';
                  publicImgUrl = `${sbUrl}/storage/v1/object/public/spaces-public/${fileName}`;
                } else if (sourceUrl) {
                  publicImgUrl = sourceUrl;
                }
              }
            } catch (imgErr) {
              console.error('Error uploading space image to Supabase storage:', imgErr);
            }
          }

          await supabaseAdmin.from('space_images').insert({
            space_id: space.id,
            image_path: publicImgUrl,
            display_order: 0,
          });

          // Automatically broadcast to public Telegram Channel with 'Order in Bot' button
          try {
            await broadcastListingToChannel(space.id);
          } catch (broadcastErr) {
            console.error('Channel auto-broadcast error:', broadcastErr);
          }
        }

        if (callback.id) {
          await sendTelegram('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: '✅ Space Approved & Published!',
          });
        }

        // Update Admin chat message
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>✅ Space Approved & Published!</b>\n\nListing <b>${draft.title}</b> is now live on the RoomMatch Mini App!`,
          parse_mode: 'HTML',
        });

        // Notify Homeowner via DM
        const homeownerNotice = `
<b>🎉 Congratulations! Your Listing is Live!</b>

Your room listing for <b>${draft.title}</b> in <b>${draft.neighborhood}</b> has been approved and published by our admin team!

Renters can now discover your property on the RoomMatch Mini App.
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: draft.homeowner_telegram_id,
          text: homeownerNotice,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // 1.4 Admin Space Rejection Callback
      if (callbackData.startsWith('space_reject:')) {
        const draftId = callbackData.split(':')[1];
        const draft = getDraft(draftId);

        if (!draft) {
          if (callback.id) {
            await sendTelegram('answerCallbackQuery', {
              callback_query_id: callback.id,
              text: 'Draft listing not found.',
              show_alert: true,
            });
          }
          return NextResponse.json({ ok: true });
        }

        if (draft.status !== 'pending') {
          if (callback.id) {
            await sendTelegram('answerCallbackQuery', {
              callback_query_id: callback.id,
              text: `This space is already ${draft.status.toUpperCase()}.`,
              show_alert: true,
            });
          }
          return NextResponse.json({ ok: true });
        }

        if (callback.id) {
          await sendTelegram('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Prompting for rejection reason...',
          });
        }

        saveSession({
          telegram_id: callback.from.id,
          step: `awaiting_reject_reason:${draftId}`,
          draft_data: { draftId },
          updated_at: new Date().toISOString(),
        });

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>❌ Rejecting Space Listing: "${draft.title}"</b>\n\nPlease reply with the reason for rejecting this listing (e.g. <i>"Photos are blurry"</i> or <i>"Price is invalid"</i>):`,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ ok: true });
    }

    // =========================================================================
    // 2. HANDLE MESSAGES & TEXT COMMANDS
    // =========================================================================
    if (update.message) {
      const message = update.message;
      const chatId: number = message.chat.id;
      const fromUser = message.from;
      const text: string = (message.text || '').trim();

      if (fromUser && fromUser.id) {
        const usernameLower = (fromUser.username || '').toLowerCase();
        const isAdminUsername = ['wwehid', 'birukadiyee', 'spacematchaddis_bot'].includes(usernameLower);

        // Sync user in database
        await supabaseAdmin
          .from('users')
          .upsert(
            {
              telegram_id: fromUser.id,
              first_name: fromUser.first_name || 'User',
              last_name: fromUser.last_name || null,
              username: fromUser.username || null,
              role: isAdminUsername ? 'admin' : 'renter',
              fayda_status: isAdminUsername ? 'verified' : 'pending',
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'telegram_id' }
          );
      }

      const session = getSession(chatId);

      // Handle Cancel Command
      if (text === '/cancel' || text.toLowerCase() === 'cancel' || text === 'ሰርዝ') {
        clearSession(chatId);
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '❌ Process cancelled. You can restart anytime by selecting <b>"🏠 I Have a Space"</b> or typing /start.',
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // -----------------------------------------------------------------------
      // 2.1 DEEP LINK /start HANDLERS
      // -----------------------------------------------------------------------

      // 2.1.1 /start order_{listing_id}
      if (text.startsWith('/start order_')) {
        const listingId = text.replace('/start order_', '').trim();
        const { data: space } = await supabaseAdmin.from('spaces').select('*').eq('id', listingId).single();

        if (!space) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Requested space listing could not be found.',
          });
          return NextResponse.json({ ok: true });
        }

        // Check if user already has completed order
        const { data: completedOrder } = await supabaseAdmin
          .from('orders')
          .select('*')
          .eq('renter_telegram_id', chatId)
          .eq('space_id', space.id)
          .eq('payment_status', 'completed')
          .maybeSingle();

        if (completedOrder) {
          await sendUnlockedContactDetails(chatId, space);
          return NextResponse.json({ ok: true });
        }

        // Create or fetch pending order
        const unlockFee = Number(space.unlock_fee || 50.00);
        let orderId = '';
        const { data: pendingOrder } = await supabaseAdmin
          .from('orders')
          .select('id')
          .eq('renter_telegram_id', chatId)
          .eq('space_id', space.id)
          .eq('payment_status', 'pending')
          .maybeSingle();

        if (pendingOrder) {
          orderId = pendingOrder.id;
        } else {
          const { data: newOrder } = await supabaseAdmin
            .from('orders')
            .insert({
              renter_telegram_id: chatId,
              space_id: space.id,
              amount: unlockFee,
              transaction_reference: `PENDING_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              payment_status: 'pending',
            })
            .select('id')
            .single();

          if (newOrder) orderId = newOrder.id;
        }

        saveSession({
          telegram_id: chatId,
          step: `awaiting_payment_for_order:${orderId}`,
          draft_data: { order_id: orderId, space_id: space.id },
          updated_at: new Date().toISOString(),
        });

        const payMessage = `
🏠 <b>UNLOCK HOST CONTACT & LOCATION DETAILS</b>

<b>Property:</b> ${space.title}
📍 <b>Neighborhood:</b> ${space.neighborhood}
💵 <b>Unlock Fee:</b> ETB ${unlockFee}

💳 <b>Telebirr Payment Account:</b>
<code>${receiverPhone}</code>

<b>Instructions:</b>
1. Transfer <b>ETB ${unlockFee}</b> to Telebirr number <code>${receiverPhone}</code>.
2. Reply directly to this message with your <b>Transaction Reference Number</b> (e.g., <i>FT... or 1000...</i>).

<i>Our automated system will verify your payment instantly!</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: payMessage,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // 2.1.2 /start pay_{order_id}
      if (text.startsWith('/start pay_')) {
        const orderId = text.replace('/start pay_', '').trim();
        const { data: order } = await supabaseAdmin
          .from('orders')
          .select('*, spaces(*)')
          .eq('id', orderId)
          .single();

        if (!order) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Order record not found.',
          });
          return NextResponse.json({ ok: true });
        }

        const space = order.spaces;

        if (order.payment_status === 'completed') {
          await sendUnlockedContactDetails(chatId, space);
          return NextResponse.json({ ok: true });
        }

        saveSession({
          telegram_id: chatId,
          step: `awaiting_payment_for_order:${order.id}`,
          draft_data: { order_id: order.id, space_id: order.space_id },
          updated_at: new Date().toISOString(),
        });

        const payMessage = `
🏠 <b>TELEBIRR PAYMENT FOR UNLOCK ORDER</b>

<b>Property:</b> ${space?.title || 'Room Listing'}
💵 <b>Unlock Fee:</b> ETB ${order.amount}

💳 <b>Telebirr Account:</b>
<code>${receiverPhone}</code>

Please transfer <b>ETB ${order.amount}</b> to Telebirr number <code>${receiverPhone}</code> and reply here with your <b>Transaction Reference Number</b> (e.g., <i>9AC... or FT...</i>):
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: payMessage,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // -----------------------------------------------------------------------
      // 2.2 ADMIN REJECTION REASON CAPTURE
      // -----------------------------------------------------------------------
      if (session.step.startsWith('awaiting_reject_reason:')) {
        const draftId = session.step.split(':')[1];
        const draft = getDraft(draftId);

        if (!draft) {
          clearSession(chatId);
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Draft listing could not be found.',
          });
          return NextResponse.json({ ok: true });
        }

        const rejectionReason = text || 'Details did not meet platform guidelines.';
        draft.status = 'rejected';
        draft.rejection_reason = rejectionReason;
        saveDraft(draft);

        clearSession(chatId);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>✅ Rejection Processed!</b>\n\nReason recorded: <i>"${rejectionReason}"</i>\nNotice has been sent to the homeowner.`,
          parse_mode: 'HTML',
        });

        const homeownerRejectMessage = `
<b>❌ Listing Submission Notice</b>

Your property listing for <b>${draft.title}</b> was rejected by our admin team.

<b>Reason for Rejection:</b>
<i>${rejectionReason}</i>

Please review the reason above and click the button below to fill in and re-submit your property details.
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: draft.homeowner_telegram_id,
          text: homeownerRejectMessage,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔄 Re-submit Listing',
                  callback_data: 'start_listing',
                },
              ],
            ],
          },
        });

        return NextResponse.json({ ok: true });
      }

      // -----------------------------------------------------------------------
      // 2.3 PAYMENT TRANSACTION REFERENCE VERIFICATION ENGINE
      // -----------------------------------------------------------------------
      if (session.step.startsWith('awaiting_payment_for_order:')) {
        const orderId = session.step.split(':')[1];
        const { data: order } = await supabaseAdmin
          .from('orders')
          .select('*, spaces(*)')
          .eq('id', orderId)
          .single();

        if (!order) {
          clearSession(chatId);
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Order record could not be found.',
          });
          return NextResponse.json({ ok: true });
        }

        const space = order.spaces;
        const txRef = text.trim();

        if (!txRef) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Please enter your Telebirr Transaction Reference Number.',
          });
          return NextResponse.json({ ok: true });
        }

        // Anti-Replay Fraud Check: Verify uniqueness of transaction reference in DB
        const { data: existingUsedTx } = await supabaseAdmin
          .from('orders')
          .select('id')
          .eq('transaction_reference', txRef)
          .eq('payment_status', 'completed')
          .maybeSingle();

        if (existingUsedTx) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ <b>Fraud Notice:</b> This Transaction Reference Number has already been used and verified.',
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        // Send processing indicator
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `⏳ Verifying Transaction Reference <code>${txRef}</code> via verify.et API...`,
          parse_mode: 'HTML',
        });

        // Validate via verify.et API (or simulation for test refs)
        const isSimulation = txRef.toUpperCase().startsWith('TEST') || txRef.toUpperCase().startsWith('SIM');
        let verifyResult = isSimulation
          ? { success: true, message: 'Test verification succeeded.' }
          : await verifyTelebirrPayment(txRef, Number(order.amount || 50.00));

        if (!verifyResult.success) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `❌ <b>Payment Verification Failed</b>\n\n<i>${verifyResult.message}</i>\n\nPlease check your receipt and reply with the correct Transaction Reference Number.`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        // Complete Order in Supabase
        await supabaseAdmin
          .from('orders')
          .update({
            transaction_reference: txRef,
            payment_status: 'completed',
            verified_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        clearSession(chatId);

        // Deliver Unlocked Details
        await sendUnlockedContactDetails(chatId, space);
        return NextResponse.json({ ok: true });
      }

      // -----------------------------------------------------------------------
      // 2.4 HOMEOWNER STEP-BY-STEP PROMPT FLOW
      // -----------------------------------------------------------------------

      // Step 1 -> Step 2 (Title -> Neighborhood)
      if (session.step === 'awaiting_title') {
        if (!text) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Please enter a title for your property.',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.title = text;
        session.step = 'awaiting_neighborhood';
        saveSession(session);

        const prompt = `
<b>📍 Step 2/6: Neighborhood / Location</b>

Got it! Which area or neighborhood is your property located in?
<i>Example: Bole, Kazanchis, Sarbet, Piassa, Summit, CMC</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: prompt,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // Step 2 -> Step 3 (Neighborhood -> Price)
      if (session.step === 'awaiting_neighborhood') {
        if (!text) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Please enter the neighborhood.',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.neighborhood = text;
        session.step = 'awaiting_price';
        saveSession(session);

        const prompt = `
<b>💵 Step 3/6: Monthly Rent (ETB)</b>

How much is the monthly rent in ETB?
<i>Please enter numbers only (e.g. 15000 or 25000).</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: prompt,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // Step 3 -> Step 4 (Price -> Description)
      if (session.step === 'awaiting_price') {
        const price = parseFloat(text.replace(/[^0-9.]/g, ''));
        if (isNaN(price) || price <= 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Please enter a valid numerical rent amount in ETB (e.g. 15000).',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.price_per_month = price;
        session.step = 'awaiting_description';
        saveSession(session);

        const prompt = `
<b>📝 Step 4/6: Description & Amenities</b>

Please describe the room, rules, and amenities.
<i>Example: "Private bathroom, balcony, high-speed Wi-Fi, water tanker, non-smoking tenant preferred."</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: prompt,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // Step 4 -> Step 5 (Description -> Address & Phone)
      if (session.step === 'awaiting_description') {
        if (!text) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Please enter a description.',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.description = text;
        session.step = 'awaiting_address_phone';
        saveSession(session);

        const prompt = `
<b>📞 Step 5/6: Exact Address & Contact Phone</b>

Please enter your exact street address / landmark and phone number for verified renters.
<i>Example: "Bole Atlas behind Ednamall, Phone: 0911223344"</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: prompt,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // Step 5 -> Step 6 (Address & Phone -> Photo Upload)
      if (session.step === 'awaiting_address_phone') {
        if (!text) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Please enter your exact address and phone number.',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.exact_address = text;
        session.draft_data.contact_phone = text;
        session.step = 'awaiting_photo';
        saveSession(session);

        const prompt = `
<b>📸 Step 6/6: Property Photo</b>

Almost done! Please send a clear photo of the room or property.
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: prompt,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // Step 6: Photo Upload -> Create Draft & Send to Admins
      if (session.step === 'awaiting_photo') {
        const photoArray = message.photo;
        if (!photoArray || !Array.isArray(photoArray) || photoArray.length === 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ Please send an image/photo of your room or property to complete your submission.',
          });
          return NextResponse.json({ ok: true });
        }

        const bestPhoto = photoArray[photoArray.length - 1];
        const photoFileId = bestPhoto.file_id;

        let photoUrl: string | null = null;
        try {
          const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${photoFileId}`);
          const fileJson = await fileRes.json();
          if (fileJson?.result?.file_path) {
            photoUrl = `https://api.telegram.org/file/bot${botToken}/${fileJson.result.file_path}`;
          }
        } catch (err) {
          console.error('Error fetching file path from Telegram:', err);
        }

        const draftId = `draft_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const homeownerName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 'Homeowner';

        const draft: SpaceDraft = {
          id: draftId,
          homeowner_telegram_id: fromUser.id,
          homeowner_name: homeownerName,
          homeowner_username: fromUser.username || null,
          title: session.draft_data.title || 'Untitled Space',
          neighborhood: session.draft_data.neighborhood || 'Addis Ababa',
          price_per_month: session.draft_data.price_per_month || 0,
          description: session.draft_data.description || '',
          exact_address: session.draft_data.exact_address || '',
          contact_phone: session.draft_data.contact_phone || '',
          photo_file_id: photoFileId,
          photo_url: photoUrl,
          status: 'pending',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        saveDraft(draft);
        clearSession(chatId);

        const userConfirmation = `
<b>✅ Submission Received!</b>

Your property listing for <b>${draft.title}</b> has been submitted to our Admin Team for review.

We will notify you here as soon as an admin approves or reviews your listing!
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: userConfirmation,
          parse_mode: 'HTML',
        });

        const adminIds = await getAdminIds();
        const adminCaption = `
<b>🏠 NEW SPACE SUBMISSION FOR REVIEW</b>

<b>Title:</b> ${draft.title}
<b>Neighborhood:</b> ${draft.neighborhood}
<b>Rent:</b> ${draft.price_per_month} ETB / month
<b>Description:</b> ${draft.description}
<b>Address & Contact:</b> ${draft.exact_address}
<b>Homeowner:</b> ${draft.homeowner_name} (@${draft.homeowner_username || 'N/A'})

<i>Please review the submission and select an action below:</i>
        `.trim();

        const adminKeyboard = {
          inline_keyboard: [
            [
              {
                text: '✅ Approve & Publish',
                callback_data: `space_approve:${draftId}`,
              },
            ],
            [
              {
                text: '❌ Reject Space',
                callback_data: `space_reject:${draftId}`,
              },
            ],
          ],
        };

        for (const adminId of adminIds) {
          await sendTelegram('sendPhoto', {
            chat_id: adminId,
            photo: photoFileId,
            caption: adminCaption,
            parse_mode: 'HTML',
            reply_markup: adminKeyboard,
          });
        }

        return NextResponse.json({ ok: true });
      }

      // -----------------------------------------------------------------------
      // 2.5 EXTENDED TELEGRAM BOT COMMAND HANDLERS
      // -----------------------------------------------------------------------

      // /browse or /rooms
      if (text === '/browse' || text === '/rooms') {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>🔍 Browse Rooms in Addis Ababa</b>\n\nTap the button below to launch the SpaceMatch Mini App storefront!`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🏪 Open SpaceMatch Mini App',
                  web_app: { url: appUrl },
                },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // /post or /addroom
      if (text === '/post' || text === '/addroom') {
        saveSession({
          telegram_id: chatId,
          step: 'awaiting_title',
          draft_data: {},
          updated_at: new Date().toISOString(),
        });
        const promptText = `
<b>🏠 Step 1/6: Property Title</b>

Please enter a clear title for your room or property.
<i>Example: "Cozy 1BR Apartment in Bole" or "Furnished Private Room near Kazanchis"</i>

<i>(Type /cancel at any point to stop)</i>
        `.trim();
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: promptText,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // /myorders or /unlocked
      if (text === '/myorders' || text === '/unlocked') {
        const { data: userOrders } = await supabaseAdmin
          .from('orders')
          .select('*, spaces(*)')
          .eq('renter_telegram_id', chatId)
          .eq('payment_status', 'completed');

        if (!userOrders || userOrders.length === 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `<b>📂 My Unlocked Rooms</b>\n\nYou have not unlocked any room contacts yet.\n\nBrowse available rooms in the Mini App and unlock contacts for ETB 50!`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 Browse Rooms Now', web_app: { url: appUrl } }],
              ],
            },
          });
          return NextResponse.json({ ok: true });
        }

        let msg = `<b>📂 My Unlocked Room Contacts (${userOrders.length})</b>\n\n`;
        userOrders.forEach((o: any, idx: number) => {
          const s = o.spaces;
          if (s) {
            msg += `${idx + 1}. <b>${s.title}</b> (${s.neighborhood})\n`;
            msg += `📍 Address: ${s.exact_address}\n`;
            msg += `📞 Host: ${s.contact_name} (${s.contact_phone})\n`;
            msg += `💬 Telegram: ${s.contact_telegram || 'N/A'}\n\n`;
          }
        });

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: msg.trim(),
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // /verify or /fayda
      if (text === '/verify' || text === '/fayda') {
        const { data: user } = await supabaseAdmin
          .from('users')
          .select('fayda_status')
          .eq('telegram_id', chatId)
          .maybeSingle();

        const status = user?.fayda_status || 'pending';
        const statusBadge = status === 'verified' ? '✅ Verified' : '⚠️ Pending Verification';

        const verifyMsg = `
<b>🆔 Fayda National ID Verification</b>

<b>Current Status:</b> ${statusBadge}

Verified users get full access to unlock room contact details and fast-track landlord inquiries.
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: verifyMsg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🆔 Upload Fayda ID in Mini App', web_app: { url: appUrl } }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // /help
      if (text === '/help') {
        const helpText = `
<b>❓ SpaceMatch Help & Guide</b>

<b>🔍 For Renters:</b>
1. Tap <b>"Browse Rooms"</b> or type /browse to open the Mini App.
2. Filter rooms by location (Bole, Kazanchis, etc.) and category.
3. Tap <b>"Unlock Contacts"</b> to pay the ETB 50 fee via Telebirr.
4. Once verified, host phone number and Google Maps location are unlocked!

<b>🏠 For Homeowners:</b>
1. Tap <b>"I Have a Space"</b> or type /post to start listing.
2. Enter room title, description, price, neighborhood, and exact address.
3. Upload a photo.
4. Once an admin approves, your space is live on the Mini App & Telegram Channel!

<b>📜 Commands List:</b>
/start - Welcome screen & main menu
/browse - Open Mini App Storefront
/post - List a room for rent
/myorders - View your unlocked room contacts
/verify - Check Fayda ID verification status
/support - Contact Admin Support
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: helpText,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // /support
      if (text === '/support') {
        const supportText = `
<b>💬 SpaceMatch Admin Support</b>

Have questions or need assistance with a room listing or payment?

<b>Admins:</b>
• @birukadiyee
• @WWEHID

<i>Working hours: 8:00 AM - 10:00 PM EAT</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: supportText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Message Support Admin', url: 'https://t.me/birukadiyee' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // /broadcast <listing_id> (Admin Only)
      if (text.startsWith('/broadcast ')) {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Admin permission required.' });
          return NextResponse.json({ ok: true });
        }

        const listingId = text.replace('/broadcast ', '').trim();
        const broadcastRes = await broadcastListingToChannel(listingId);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: broadcastRes.success
            ? `<b>✅ Broadcast Sent!</b>\n\n${broadcastRes.message}`
            : `<b>❌ Broadcast Failed</b>\n\n${broadcastRes.message}`,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // /stats (Admin Only)
      if (text === '/stats') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Admin permission required.' });
          return NextResponse.json({ ok: true });
        }

        const { count: publishedCount } = await supabaseAdmin.from('spaces').select('*', { count: 'exact', head: true }).eq('status', 'published');
        const { count: completedOrdersCount } = await supabaseAdmin.from('orders').select('*', { count: 'exact', head: true }).eq('payment_status', 'completed');
        const { count: verifiedUsersCount } = await supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('fayda_status', 'verified');

        const totalRevenue = (completedOrdersCount || 0) * 50;

        const statsText = `
<b>📊 SpaceMatch Admin Platform Statistics</b>

🏠 <b>Published Spaces:</b> ${publishedCount || 0}
🔓 <b>Completed Orders:</b> ${completedOrdersCount || 0}
💵 <b>Total Revenue:</b> ETB ${totalRevenue.toLocaleString()}
🆔 <b>Verified Users:</b> ${verifiedUsersCount || 0}
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: statsText,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      if (
        text.includes('Have a Space') ||
        text.includes('List') ||
        text.includes('ሀብት') ||
        text.includes('ቦታ አለኝ')
      ) {
        saveSession({
          telegram_id: chatId,
          step: 'awaiting_title',
          draft_data: {},
          updated_at: new Date().toISOString(),
        });

        const promptText = `
<b>🏠 Step 1/6: Property Title</b>

Please enter a clear title for your room or property.
<i>Example: "Cozy 1BR Apartment in Bole" or "Furnished Private Room near Kazanchis"</i>

<i>(Type /cancel at any point to stop)</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: promptText,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // Handle /start Command
      if (text.startsWith('/start')) {
        clearSession(chatId);
        const welcomeText = `
<b>👋 Welcome to RoomMatch Ethiopia!</b>

Whether you are looking for a room or want to list your space, we've got you covered.

Choose an option below to get started:
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔍 I Need a Space (Open Mini App)',
                  web_app: { url: appUrl },
                },
              ],
              [
                {
                  text: '🏠 I Have a Space (List Property)',
                  callback_data: 'start_listing',
                },
              ],
              [
                {
                  text: '💬 Contact Admin Team',
                  url: 'https://t.me/birukadiyee',
                },
              ],
            ],
          },
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('Telegram Webhook Exception:', msg);
    return NextResponse.json({ ok: true });
  }
}
