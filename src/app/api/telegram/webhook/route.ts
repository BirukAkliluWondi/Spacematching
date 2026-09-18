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

    // Helper to format unlocked space details message in Amharic
    const sendUnlockedContactDetails = async (chatId: number, space: any) => {
      const lat = space.latitude || 9.001245;
      const lng = space.longitude || 38.784512;
      const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
      const contactTg = space.contact_telegram ? (space.contact_telegram.startsWith('@') ? space.contact_telegram : `@${space.contact_telegram}`) : 'የለም';

      const text = `
<b>✅ ክፍያው ተረጋግጧል! አድራሻና ስልክ ተከፍቷል!</b>

🏠 <b>ቤት፡</b> ${space.title}
📍 <b>ትክክለኛ አድራሻ፡</b> ${space.exact_address}
🗺️ <b>ጉግል ማፕ አድራሻ፡</b> ${mapsUrl}

📞 <b>የባለቤቱ ስልክ፡</b> ${space.contact_name} (${space.contact_phone})
💬 <b>ቴሌግራም፡</b> ${contactTg}

<i>SpaceMatch ኢትዮጵያን ስለተጠቀሙ እናመሰግናለን!</i>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🗺️ ጉግል ማፕ ክፈት',
                url: mapsUrl,
              },
            ],
            [
              {
                text: '📞 አሁኑኑ ደውል',
                url: `tel:${space.contact_phone}`,
              },
            ],
          ],
        },
      });
    };

    // Helper to prompt phone number registration for Homeowners
    const triggerPhoneRegistrationPrompt = async (chatId: number) => {
      saveSession({
        telegram_id: chatId,
        step: 'awaiting_phone_registration',
        draft_data: {},
        updated_at: new Date().toISOString(),
      });

      const regPrompt = `
📱 <b>የቤት አከራይ ምዝገባ (Phone Registration Required)</b>

ክፍልዎን ለማከራየት በመጀመሪያ የጸና የስልክ ቁጥርዎን መመዝገብ አለብዎት።

እባክዎን ከታች ያለውን <b>"📱 የስልክ ቁጥርዎን ያጋሩ"</b> የሚለውን ቁልፍ በመጫን ስልክ ቁጥርዎን ያረጋግጡ።

<i>(ይህ ለተከራዮች ደህንነትና ለቤት አከራዮች ማረጋገጫ ብቻ የሚያገለግል ነው)</i>
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: regPrompt,
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: [
            [
              {
                text: '📱 የስልክ ቁጥርዎን ያጋሩ (Share Phone Number)',
                request_contact: true,
              },
            ],
            [{ text: '❌ ሰርዝ / Cancel' }],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
    };

    // Helper to send Order Checkout Card (with exact post photo & details) in Bot DM
    const sendOrderCheckoutPrompt = async (chatId: number, spaceId: string) => {
      const { data: space } = await supabaseAdmin.from('spaces').select('*').eq('id', spaceId).single();
      if (!space) {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '⚠️ የተጠየቀው ቤት መረጃ አልተገኘም።',
        });
        return;
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
        return;
      }

      // Fetch cover image
      const { data: images } = await supabaseAdmin
        .from('space_images')
        .select('image_path')
        .eq('space_id', space.id)
        .order('display_order', { ascending: true })
        .limit(1);

      const photoUrl =
        images && images.length > 0
          ? images[0].image_path
          : 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80';

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

      const cardCaption = `
🏠 <b>የመረጡት ክፍል መረጃ (Selected Room Post)</b>

<b>${space.title}</b>
📍 <b>አካባቢ፡</b> ${space.neighborhood}
💵 <b>ወርሃዊ ኪራይ፡</b> ${Number(space.price_per_month).toLocaleString()} ብር / በወር
🔓 <b>የአገልግሎት ክፍያ፡</b> ${unlockFee} ብር

📝 <b>መግለጫ፡</b>
${space.description}

----------------------------------
💳 <b>የቤት ባለቤቱን ስልክና አድራሻ ለማግኘት</b>

1. <b>${unlockFee} ብር</b> ወደ ቴሌብር ቁጥር <code>${receiverPhone}</code> ያስተላልፉ።
2. የላኩበትን <b>የቴሌብር ትራንዛክሽን ቁጥር (Txn Ref / FT...)</b> እዚህ መልሰው ይፃፉ።

<i>(ለማቆም /cancel ይፃፉ)</i>
      `.trim();

      await sendTelegram('sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption: cardCaption,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '❌ ሰርዝ / Cancel (/cancel)', callback_data: 'admin_cancel' },
            ],
          ],
        },
      });
    };

    // Helper to Sync Channel Posts into Bot Catalog
    const syncChannelPostToSpace = async (post: any): Promise<string> => {
      const captionOrText: string = post.caption || post.text || '';
      if (!captionOrText) return '';

      const lines = captionOrText.split('\n').map((l: string) => l.trim()).filter(Boolean);
      const title = lines[0] || 'አዲስ የቻነል ክፍል (Channel Listing)';

      const priceMatch = captionOrText.match(/(\d[\d,]+)\s*(?:ብር|etb|birr)/i);
      const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : 10000;

      const hoodMatch = captionOrText.match(/(?:አካባቢ|ቦታ|neighborhood|location)[:\s]*([^\n]+)/i);
      const neighborhood = hoodMatch ? hoodMatch[1].trim() : 'Addis Ababa';

      let photoUrl = 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80';
      if (post.photo && post.photo.length > 0 && botToken) {
        const largestPhoto = post.photo[post.photo.length - 1];
        try {
          const fRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${largestPhoto.file_id}`);
          const fJson = await fRes.json();
          if (fJson?.result?.file_path) {
            photoUrl = `https://api.telegram.org/file/bot${botToken}/${fJson.result.file_path}`;
          }
        } catch {}
      }

      const { data: existingSpace } = await supabaseAdmin
        .from('spaces')
        .select('id')
        .eq('description', captionOrText)
        .maybeSingle();

      if (existingSpace) {
        return existingSpace.id;
      }

      const { data: newSpace } = await supabaseAdmin
        .from('spaces')
        .insert({
          title: title.slice(0, 100),
          description: captionOrText,
          price_per_month: price,
          unlock_fee: 50.00,
          neighborhood,
          exact_address: `${neighborhood}, Addis Ababa`,
          contact_name: 'Channel Admin',
          contact_phone: '+251987310978',
          contact_telegram: '@birukadiyee',
          status: 'published',
        })
        .select('id')
        .single();

      if (newSpace?.id) {
        await supabaseAdmin.from('space_images').insert({
          space_id: newSpace.id,
          image_path: photoUrl,
          display_order: 0,
        });
        return newSpace.id;
      }

      return '';
    };

    // Helper to Search and Send Matched Room Photo Cards
    const executeRoomSearchAndSendResults = async (
      chatId: number,
      searchData: { neighborhood?: string; max_budget?: number; room_type?: string }
    ) => {
      const { neighborhood, max_budget, room_type } = searchData;

      let query = supabaseAdmin
        .from('spaces')
        .select('*, space_images(*)')
        .eq('status', 'published');

      if (max_budget && max_budget > 0) {
        query = query.lte('price_per_month', max_budget);
      }

      const { data: spaces } = await query.order('created_at', { ascending: false });

      let matchedSpaces = spaces || [];

      // Filter by neighborhood if specified (fuzzy match)
      if (neighborhood && neighborhood !== 'Any' && neighborhood !== 'ማንኛውም') {
        const targetHood = neighborhood.toLowerCase();
        matchedSpaces = matchedSpaces.filter(
          (s) =>
            (s.neighborhood || '').toLowerCase().includes(targetHood) ||
            (s.title || '').toLowerCase().includes(targetHood) ||
            (s.description || '').toLowerCase().includes(targetHood)
        );
      }

      // Filter by room_type if specified
      if (room_type && room_type !== 'Any' && room_type !== 'ማንኛውም') {
        const targetType = room_type.toLowerCase();
        matchedSpaces = matchedSpaces.filter(
          (s) =>
            (s.title || '').toLowerCase().includes(targetType) ||
            (s.description || '').toLowerCase().includes(targetType)
        );
      }

      if (!matchedSpaces || matchedSpaces.length === 0) {
        const notFoundText = `
<b>🔔 ፍላጎትዎ በሲስተማችን ተመዝግቧል!</b>

በአሁኑ ጊዜ ${neighborhood && neighborhood !== 'Any' ? `በ<b>${neighborhood}</b> ` : ''}${max_budget ? `እስከ <b>${Number(max_budget).toLocaleString()} ብር</b> ` : ''}የሚከራይ ክፍት ቤት አልተገኘም።

<b>የፍላጎትዎ መረጃ ተመዝግቧል፤</b> አከራዮች ተመሳሳይ ቤት ሲመዘግቡ ወይም በቻነል ሲለጠፍ ሲስተማችን ወዲያውኑ መልእክት ይልክልዎታል!
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: notFoundText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔍 በሚኒ አፕ ሁሉንም ክፍሎች ተመልከት', web_app: { url: appUrl } },
              ],
              [
                { text: '🎯 አዲስ ስፔሲፊኬሽን ፈልግ', callback_data: 'start_matching_wizard' },
              ],
            ],
          },
        });
        return;
      }

      // Matching rooms found!
      const summaryText = `
🎯 <b>${matchedSpaces.length} የሚመሳሰሉ ክፍሎች ተገኝተዋል!</b>

ከታች ከተዘረዘሩት ክፍሎች የፈለጉትን መርጠው በቦት ማዘዝ ይችላሉ፡
      `.trim();

      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: summaryText,
        parse_mode: 'HTML',
      });

      // Display top 5 matched spaces as photo cards
      const topMatches = matchedSpaces.slice(0, 5);
      for (const space of topMatches) {
        const photoUrl =
          space.space_images && space.space_images.length > 0
            ? space.space_images[0].image_path
            : 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=1200&q=80';

        const cardCaption = `
🏠 <b>${space.title}</b>
📍 <b>አካባቢ፡</b> ${space.neighborhood}
💵 <b>ወርሃዊ ኪራይ፡</b> ${Number(space.price_per_month).toLocaleString()} ብር / በወር
🔓 <b>የአገልግሎት ክፍያ፡</b> ${space.unlock_fee || 50} ብር

📝 <b>መግለጫ፡</b>
${space.description}
        `.trim();

        await sendTelegram('sendPhoto', {
          chat_id: chatId,
          photo: photoUrl,
          caption: cardCaption,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `🛒 በቦት እዘዝ (${space.unlock_fee || 50} ብር)`,
                  url: `https://t.me/${botUsername}?start=order_${space.id}`,
                },
              ],
              [
                {
                  text: '🔍 በሚኒ አፕ ተመልከት',
                  url: `https://t.me/${botUsername}/${appName}?startapp=listing_${space.id}`,
                },
              ],
            ],
          },
        });
      }
    };

    // =========================================================================
    // 1. HANDLE INLINE CALLBACK QUERIES
    // =========================================================================
    if (update.callback_query) {
      const callback = update.callback_query;
      const callbackData: string = callback.data || '';
      const chatId: number = callback.message?.chat?.id || callback.from.id;

      // 1.0 Direct Order Callback Handler (from channel / menu selection)
      if (callbackData.startsWith('start_order_direct:')) {
        const spaceId = callbackData.split(':')[1];
        await sendOrderCheckoutPrompt(chatId, spaceId);
        return NextResponse.json({ ok: true });
      }

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
            text: `የፋይዳ መታወቂያ ሁኔታ፡ ${newStatus === 'verified' ? 'ተረጋግጧል' : 'ውድቅ ሆኗል'}`,
          });
        }

        const renterNotice = newStatus === 'verified'
          ? `<b>✅ ማንነትዎ ተረጋግጧል!</b>\n\nየፋይዳ ብሔራዊ መታወቂያዎ በአስተዳዳሪዎች ተረጋግጧል። አሁን በSpaceMatch ላይ የቤት ባለቤቶችን ስልክ ቁጥር ማግኘት ይችላሉ።`
          : `<b>❌ የማረጋገጫ ማሳወቂያ</b>\n\nየፋይዳ መታወቂያዎ ሊረጋገጥ አልቻለም። እባክዎን ሚኒ አፑን በመክፈት ግልጽ ፎቶ እንደገና ይስቀሉ።`;

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

        // Check if user has registered phone number
        const { data: userRecord } = await supabaseAdmin
          .from('users')
          .select('phone_number')
          .eq('telegram_id', chatId)
          .maybeSingle();

        if (!userRecord || !userRecord.phone_number) {
          await triggerPhoneRegistrationPrompt(chatId);
          return NextResponse.json({ ok: true });
        }

        saveSession({
          telegram_id: chatId,
          step: 'awaiting_title',
          draft_data: { homeowner_phone: userRecord.phone_number, contact_phone: userRecord.phone_number },
          updated_at: new Date().toISOString(),
        });

        const promptText = `
<b>🏠 ደረጃ 1/6፡ የቤቱ/ክፍሉ ስም (ርዕስ)</b>

እባክዎን የክፍልዎን ወይም የቤትዎን አጭር መግለጫ ስም ያስገቡ።
<i>ምሳሌ፡ "በቦሌ የሚከራይ ባለ 1 መኝታ ቤት" ወይም "በካዛንችስ የሚከራይ ስቱዲዮ"</i>

<i>(ለማቆም /cancel ይፃፉ)</i>
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
              text: 'የተመዘገበው ቤት መረጃ አልተገኘም።',
              show_alert: true,
            });
          }
          return NextResponse.json({ ok: true });
        }

        if (draft.status !== 'pending') {
          if (callback.id) {
            await sendTelegram('answerCallbackQuery', {
              callback_query_id: callback.id,
              text: `ይህ ቤት ቀደም ሲል ${draft.status === 'approved' ? 'ጽድቋል' : 'ውድቅ ሆኗል'}።`,
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
            text: '✅ ቤቱ ጸድቆ በሚኒ አፕ እና በቻነል ታትሟል!',
          });
        }

        // Update Admin chat message
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>✅ ቤቱ ጸድቆ ታትሟል!</b>\n\nየቤቱ ስም፡ <b>${draft.title}</b> አሁን በሚኒ አፕና በቻነል ላይ ይገኛል!`,
          parse_mode: 'HTML',
        });

        // Notify Homeowner via DM
        const homeownerNotice = `
<b>🎉 እንኳን ደስ አለዎት! ቤትዎ ታትሟል!</b>

በ<b>${draft.neighborhood}</b> የሚገኘው <b>${draft.title}</b> በቤት አከራይነት በአስተዳዳሪዎች ጸድቋል!\n\nተከራዮች አሁን በሚኒ አፑ ላይ ቤትዎን ማግኘት ይችላሉ።
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
              text: 'የተመዘገበው ቤት መረጃ አልተገኘም።',
              show_alert: true,
            });
          }
          return NextResponse.json({ ok: true });
        }

        if (draft.status !== 'pending') {
          if (callback.id) {
            await sendTelegram('answerCallbackQuery', {
              callback_query_id: callback.id,
              text: `ይህ ቤት ቀደም ሲል ${draft.status === 'approved' ? 'ጽድቋል' : 'ውድቅ ሆኗል'}።`,
              show_alert: true,
            });
          }
          return NextResponse.json({ ok: true });
        }

        if (callback.id) {
          await sendTelegram('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'ውድቅ የተደረገበትን ምክንያት ያስገቡ...',
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
          text: `<b>❌ ቤቱን ውድቅ ማድረግ፡ "${draft.title}"</b>\n\nእባክዎን ውድቅ የተደረገበትን ምክንያት ይፃፉ (ምሳሌ፡ <i>"ፎቶው አይታይም"</i> ወይም <i>"የስልክ ቁጥር ይጎድላል"</i>)፡`,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // 1.5 Admin Panel Dashboard & Menu Callbacks
      if (callbackData === 'admin_menu') {
        const adminText = `
<b>👑 የSpaceMatch ኢትዮጵያ አስተዳዳሪ ፓነል (Admin Panel)</b>

እንኳን ደህና መጡ! ከታች ካሉት አማራጮች በመምረጥ የቴሌግራም ቻነል ልጥፎችን እና ክፍሎችን ማስተዳደር ይችላሉ።
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: adminText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📢 ለቻነል ለጥፍ (Post to Channel)', callback_data: 'admin_post_menu' },
              ],
              [
                { text: '🗑️ ከቻነል/ከሲስተም ሰርዝ (Delete Post)', callback_data: 'admin_delete_menu' },
              ],
              [
                { text: '➕ ብጁ ማስታወቂያ ለጥፍ (Custom Post)', callback_data: 'admin_custom_prompt' },
              ],
              [
                { text: '📋 የተመዘገቡ ክፍሎች (View Spaces)', callback_data: 'admin_list_spaces' },
              ],
              [
                { text: '❌ ውጣ / Cancel (/cancel)', callback_data: 'admin_cancel' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'nav_start' || callbackData === 'admin_cancel') {
        clearSession(chatId);
        const welcomeText = `
<b>👋 እንኳን ወደ SpaceMatch ኢትዮጵያ በደህና መጡ!</b>

ክፍል መከራየት ቢፈልጉ ወይም የእርስዎን ቤት ማከራየት ቢፈልጉ፣ በአንድ ቦታ ያገኛሉ።

ለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ፡
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎯 ክፍል እፈልጋለሁ (ስፔሲፊኬሽን መግለጫ)',
                  callback_data: 'start_matching_wizard',
                },
              ],
              [
                {
                  text: '🔍 በሚኒ አፕ ክፍሎችን ተመልከት',
                  web_app: { url: appUrl },
                },
              ],
              [
                {
                  text: '🏠 ማከራየት እፈልጋለሁ (ቤት መዝግብ)',
                  callback_data: 'start_listing',
                },
              ],
              [
                {
                  text: '💬 አስተዳዳሪውን ያናግሩ',
                  url: 'https://t.me/birukadiyee',
                },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // Room Matching Wizard Callbacks
      if (callbackData === 'start_matching_wizard') {
        if (callback.id) {
          await sendTelegram('answerCallbackQuery', { callback_query_id: callback.id });
        }

        saveSession({
          telegram_id: chatId,
          step: 'awaiting_match_neighborhood',
          draft_data: {},
          updated_at: new Date().toISOString(),
        });

        const step1Msg = `
🎯 <b>ደረጃ 1/3፡ መከራየት የሚፈልጉበትን አካባቢ ይምረጡ ወይም ይፃፉ</b>

ምሳሌ፡ ቦሌ, ካዛንችስ, ሳርቤት, ፒያሳ, 4 ኪሎ...

<i>(ለማቆም /cancel ይፃፉ)</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: step1Msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📍 ቦሌ (Bole)', callback_data: 'match_hood:Bole' },
                { text: '📍 ካዛንችስ (Kazanchis)', callback_data: 'match_hood:Kazanchis' },
              ],
              [
                { text: '📍 ሳርቤት (Sarbet)', callback_data: 'match_hood:Sarbet' },
                { text: '📍 4 ኪሎ (4 Kilo)', callback_data: 'match_hood:4 Kilo' },
              ],
              [
                { text: '📍 ፒያሳ (Piassa)', callback_data: 'match_hood:Piassa' },
                { text: '🌐 ማንኛውም አካባቢ', callback_data: 'match_hood:Any' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_hood:')) {
        const hood = callbackData.split(':')[1];
        if (callback.id) {
          await sendTelegram('answerCallbackQuery', { callback_query_id: callback.id });
        }

        saveSession({
          telegram_id: chatId,
          step: 'awaiting_match_budget',
          draft_data: { neighborhood: hood },
          updated_at: new Date().toISOString(),
        });

        const step2Msg = `
💵 <b>ደረጃ 2/3፡ በወር መክፈል የሚችሉት ከፍተኛው ክፍያ (በጀት) ስንት ነው?</b>

አካባቢ፡ <b>${hood === 'Any' ? 'ማንኛውም' : hood}</b>

እባክዎን የገንዘብ መጠኑን በብር ይፃፉ (ምሳሌ፡ 10000 ወይም 15000) ወይም ከታች ካሉት ይምረጡ፡
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: step2Msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💵 እስከ 5,000 ብር', callback_data: 'match_budget:5000' },
                { text: '💵 እስከ 10,000 ብር', callback_data: 'match_budget:10000' },
              ],
              [
                { text: '💵 እስከ 15,000 ብር', callback_data: 'match_budget:15000' },
                { text: '💵 እስከ 25,000 ብር', callback_data: 'match_budget:25000' },
              ],
              [
                { text: '💵 ማንኛውም በጀት', callback_data: 'match_budget:0' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_budget:')) {
        const budgetStr = callbackData.split(':')[1];
        const budget = parseInt(budgetStr, 10) || 0;
        if (callback.id) {
          await sendTelegram('answerCallbackQuery', { callback_query_id: callback.id });
        }

        const session = getSession(chatId);
        const draftData: Record<string, any> = { ...session.draft_data, max_budget: budget };

        saveSession({
          telegram_id: chatId,
          step: 'awaiting_match_room_type',
          draft_data: draftData,
          updated_at: new Date().toISOString(),
        });

        const step3Msg = `
🏠 <b>ደረጃ 3/3፡ የሚፈልጉት የክፍል ዓይነት የትኛው ነው?</b>

አካባቢ፡ <b>${draftData.neighborhood === 'Any' ? 'ማንኛውም' : draftData.neighborhood}</b>
በጀት፡ <b>${budget > 0 ? `${budget.toLocaleString()} ብር` : 'ማንኛውም'}</b>

ከታች ከተዘረዘሩት የክፍል ዓይነቶች አንዱን ይምረጡ፡
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: step3Msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🏠 ስቱዲዮ (Studio)', callback_data: 'match_type:Studio' },
                { text: '🬀 ባለ 1 መኝታ (Single Bed)', callback_data: 'match_type:Single' },
              ],
              [
                { text: '🛏️ ማስተር ቤድሩም (Master)', callback_data: 'match_type:Master' },
                { text: '👥 የጋራ ክፍል (Shared)', callback_data: 'match_type:Shared' },
              ],
              [
                { text: '✨ ማንኛውም ዓይነት', callback_data: 'match_type:Any' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('match_type:')) {
        const rType = callbackData.split(':')[1];
        if (callback.id) {
          await sendTelegram('answerCallbackQuery', { callback_query_id: callback.id });
        }

        const session = getSession(chatId);
        const searchData = {
          neighborhood: session.draft_data.neighborhood,
          max_budget: session.draft_data.max_budget,
          room_type: rType,
        };

        clearSession(chatId);
        await executeRoomSearchAndSendResults(chatId, searchData);
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_post_menu') {
        const { data: spaces } = await supabaseAdmin
          .from('spaces')
          .select('id, title, neighborhood, price_per_month')
          .eq('status', 'published')
          .order('created_at', { ascending: false });

        if (!spaces || spaces.length === 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ ለቻነል የሚለጠፍ የታተመ ቤት የለም።',
          });
          return NextResponse.json({ ok: true });
        }

        const buttons = spaces.map((s) => [
          {
            text: `📢 ለጥፍ፡ ${s.title} (${s.neighborhood})`,
            callback_data: `admin_do_post:${s.id}`,
          },
        ]);
        buttons.push([{ text: '🔙 ወደ Admin Dashboard ተመለስ', callback_data: 'admin_menu' }]);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '<b>📢 በቴሌግራም ቻነል ለመለጠፍ የሚፈልጉትን ቤት ይምረጡ፡</b>',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('admin_do_post:')) {
        const spaceId = callbackData.split(':')[1];
        const res = await broadcastListingToChannel(spaceId);
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: res.success
            ? `<b>✅ በቻነል ተለጥፏል!</b>\n\n${res.message}`
            : `<b>❌ መለጠፍ አልተሳካም፡</b> ${res.message}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👑 ወደ Admin Panel ተመለስ', callback_data: 'admin_menu' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_delete_menu') {
        const { data: spaces } = await supabaseAdmin
          .from('spaces')
          .select('id, title, neighborhood, price_per_month')
          .eq('status', 'published')
          .order('created_at', { ascending: false });

        if (!spaces || spaces.length === 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ የሚሰረዝ የታተመ ቤት የለም።',
          });
          return NextResponse.json({ ok: true });
        }

        const buttons = spaces.map((s) => [
          {
            text: `🗑️ ሰርዝ፡ ${s.title} (${s.neighborhood})`,
            callback_data: `admin_do_delete:${s.id}`,
          },
        ]);
        buttons.push([{ text: '🔙 ወደ Admin Dashboard ተመለስ', callback_data: 'admin_menu' }]);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '<b>🗑️ ከቻነልና ከሲስተም ለመሰረዝ የሚፈልጉትን ቤት ይምረጡ፡</b>\n\nይህ ቤት ከሚኒ አፕ ሰርዞ ከቻነል ያስወግደዋል።',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData.startsWith('admin_do_delete:')) {
        const spaceId = callbackData.split(':')[1];
        const { data: space } = await supabaseAdmin.from('spaces').select('title').eq('id', spaceId).single();

        await supabaseAdmin
          .from('spaces')
          .update({ status: 'archived', updated_at: new Date().toISOString() })
          .eq('id', spaceId);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>🗑️ ቤቱ ተሰርዟል!</b>\n\nቤት፡ <b>${space?.title || spaceId}</b> ከታተሙ ክፍሎች ዝርዝር ተወግዷል።`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👑 ወደ Admin Panel ተመለስ', callback_data: 'admin_menu' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_custom_prompt') {
        saveSession({
          telegram_id: chatId,
          step: 'awaiting_custom_channel_post',
          draft_data: {},
          updated_at: new Date().toISOString(),
        });

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>✍️ ብጁ ማስታወቂያ በቻነል ለመለጠፍ</b>\n\nእባክዎን በቻነል መለጠፍ የሚፈልጉትን ጽሑፍ ይፃፉ። ፎቶ ማካተት ከፈለጉ ፎቶውን ከጽሑፉ (Caption) ጋር ይላኩ።\n\n<i>(ለማቆም /cancel ይፃፉ)</i>`,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      if (callbackData === 'admin_list_spaces') {
        const { data: spaces } = await supabaseAdmin
          .from('spaces')
          .select('id, title, neighborhood, price_per_month, unlock_fee, status')
          .order('created_at', { ascending: false })
          .limit(10);

        if (!spaces || spaces.length === 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ ምንም የተመዘገቡ ክፍሎች የሉም።',
          });
          return NextResponse.json({ ok: true });
        }

        let msg = '<b>📋 በሲስተሙ የተመዘገቡ ክፍሎች፡</b>\n\n';
        spaces.forEach((s, idx) => {
          const statusIcon = s.status === 'published' ? '✅' : '📦';
          msg += `${idx + 1}. ${statusIcon} <b>${s.title}</b> (${s.neighborhood}) - ${s.price_per_month} ETB/ወር (ክፍያ: ${s.unlock_fee} ETB)\n`;
        });

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👑 ወደ Admin Dashboard ተመለስ', callback_data: 'admin_menu' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ ok: true });
    }

    // =========================================================================
    // 1.5 HANDLE CHANNEL POSTS (Automatic Sync & "Order Now / በቦት እዘዝ" Button)
    // =========================================================================
    const channelPost = update.channel_post || update.edited_channel_post;
    if (channelPost) {
      const channelChatId = channelPost.chat.id;
      const messageId = channelPost.message_id;
      const captionOrText: string = channelPost.caption || channelPost.text || '';

      // Auto-sync post content into Bot Catalog
      const syncedSpaceId = await syncChannelPostToSpace(channelPost);

      // Check if this post already has an inline keyboard with an order URL
      const existingButtons = channelPost.reply_markup?.inline_keyboard;
      const hasOrderButton = existingButtons?.some((row: any[]) =>
        row.some((b: any) => b.url && b.url.includes('start=order'))
      );

      if (!hasOrderButton) {
        let targetListingId = syncedSpaceId;

        if (!targetListingId) {
          const idMatch = captionOrText.match(/(?:order_|listing_|space_)?([0-9a-fA-F-]{36})/i) ||
                          captionOrText.match(/(?:order_|listing_|space_)([0-9a-zA-Z_-]+)/i);

          if (idMatch && idMatch[1]) {
            targetListingId = idMatch[1];
          }
        }

        const orderUrl = targetListingId
          ? `https://t.me/${botUsername}?start=order_${targetListingId}`
          : `https://t.me/${botUsername}?start=order`;

        const miniAppUrl = targetListingId
          ? `https://t.me/${botUsername}/${appName}?startapp=listing_${targetListingId}`
          : `https://t.me/${botUsername}/${appName}`;

        // Edit reply markup of the channel post to attach "🛒 በቦት እዘዝ" (Order in Bot) button
        await sendTelegram('editMessageReplyMarkup', {
          chat_id: channelChatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🛒 በቦት እዘዝ (Order in Bot)',
                  url: orderUrl,
                },
              ],
              [
                {
                  text: '🔍 በሚኒ አፕ ተመልከት (View in Mini App)',
                  url: miniAppUrl,
                },
              ],
            ],
          },
        });
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

      // Handle Contact Shared / Phone Registration Step for Homeowners
      if (message.contact || session.step === 'awaiting_phone_registration') {
        const phoneNumber = message.contact?.phone_number || text;

        if (phoneNumber && phoneNumber !== '/cancel' && phoneNumber !== '❌ ሰርዝ / Cancel') {
          await supabaseAdmin
            .from('users')
            .upsert(
              {
                telegram_id: chatId,
                first_name: fromUser?.first_name || 'User',
                last_name: fromUser?.last_name || null,
                username: fromUser?.username || null,
                phone_number: phoneNumber,
                role: 'homeowner',
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'telegram_id' }
            );

          saveSession({
            telegram_id: chatId,
            step: 'awaiting_title',
            draft_data: { homeowner_phone: phoneNumber, contact_phone: phoneNumber },
            updated_at: new Date().toISOString(),
          });

          const successMsg = `
<b>✅ የስልክ ቁጥርዎ በስኬት ተመዝግቧል! (${phoneNumber})</b>

አሁን የቤትዎን መረጃ መመዝገብ መጀመር ይችላሉ።
----------------------------------
<b>🏠 ደረጃ 1/6፡ የቤቱ/ክፍሉ ስም (ርዕስ)</b>

እባክዎን የክፍልዎን ወይም የቤትዎን አጭር መግለጫ ስም ያስገቡ።
<i>ምሳሌ፡ "በቦሌ የሚከራይ ባለ 1 መኝታ ቤት" ወይም "በካዛንችስ የሚከራይ ስቱዲዮ"</i>

<i>(ለማቆም /cancel ይፃፉ)</i>
          `.trim();

          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: successMsg,
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true },
          });

          return NextResponse.json({ ok: true });
        }
      }

      // Handle Cancel Command
      if (text === '/cancel' || text.toLowerCase() === 'cancel' || text === 'ሰርዝ' || text === '/stop') {
        clearSession(chatId);
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '<b>❌ ሂደቱ ተሰርዟል! ወደ መነሻ ገጽ ተመልሰዋል።</b>\n\nለመቀጠል ከታች ከተዘረዘሩት አማራጮች አንዱን ይምረጡ፡',
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🏠 መነሻ ገጽ (/start)', callback_data: 'nav_start' },
                { text: '👑 Admin Dashboard (/admin)', callback_data: 'admin_menu' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // Handle /admin Command (Interactive Admin Dashboard)
      if (text === '/admin' || text === '/admin_panel' || text.startsWith('/admin')) {
        const adminIds = await getAdminIds();
        const usernameLower = (fromUser?.username || '').toLowerCase();
        const isKnownAdmin =
          adminIds.includes(chatId) ||
          ['wwehid', 'birukadiyee', 'spacematchaddis_bot'].includes(usernameLower);

        if (!isKnownAdmin) {
          const { data: dbUser } = await supabaseAdmin
            .from('users')
            .select('role')
            .eq('telegram_id', chatId)
            .maybeSingle();

          if (dbUser?.role !== 'admin') {
            await sendTelegram('sendMessage', {
              chat_id: chatId,
              text: '⚠️ ይቅርታ፣ ይህ ትእዛዝ ለአስተዳዳሪዎች ብቻ የተፈቀደ ነው። (Access restricted to platform admins)',
            });
            return NextResponse.json({ ok: true });
          }
        }

        const adminText = `
<b>👑 የSpaceMatch ኢትዮጵያ አስተዳዳሪ ፓነል (Admin Panel)</b>

እንኳን ደህና መጡ! ከታች ካሉት አማራጮች በመምረጥ የቴሌግራም ቻነል ልጥፎችን እና ክፍሎችን ማስተዳደር ይችላሉ።
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: adminText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📢 ለቻነል ለጥፍ (Post to Channel)', callback_data: 'admin_post_menu' },
              ],
              [
                { text: '🗑️ ከቻነል/ከሲስተም ሰርዝ (Delete Post)', callback_data: 'admin_delete_menu' },
              ],
              [
                { text: '➕ ብጁ ማስታወቂያ ለጥፍ (Custom Post)', callback_data: 'admin_custom_prompt' },
              ],
              [
                { text: '📋 የተመዘገቡ ክፍሎች (View Spaces)', callback_data: 'admin_list_spaces' },
              ],
              [
                { text: '❌ ውጣ / Cancel (/cancel)', callback_data: 'admin_cancel' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // Handle session step awaiting_custom_channel_post
      if (session.step === 'awaiting_custom_channel_post') {
        clearSession(chatId);
        const postText = message.caption || message.text || '';
        let photoUrl: string | undefined = undefined;

        if (message.photo && message.photo.length > 0) {
          const largestPhoto = message.photo[message.photo.length - 1];
          const fRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${largestPhoto.file_id}`);
          const fJson = await fRes.json();
          if (fJson?.result?.file_path) {
            photoUrl = `https://api.telegram.org/file/bot${botToken}/${fJson.result.file_path}`;
          }
        }

        const { postCustomToChannel } = await import('@/lib/telegram-broadcast');
        const res = await postCustomToChannel(postText, photoUrl);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: res.success
            ? `<b>✅ ብጁ ማስታወቂያው በቻነል ተለጥፏል!</b>`
            : `<b>❌ መለጠፍ አልተሳካም፡</b> ${res.message}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👑 ወደ Admin Dashboard ተመለስ', callback_data: 'admin_menu' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // -----------------------------------------------------------------------
      // 2.1 DEEP LINK /start HANDLERS
      // -----------------------------------------------------------------------

      // 2.1.0 General /start order (Order menu without specific space ID)
      if (text === '/start order' || text === '/start order_' || text === '/order') {
        const { data: spaces } = await supabaseAdmin
          .from('spaces')
          .select('id, title, neighborhood, price_per_month, unlock_fee')
          .eq('status', 'published')
          .order('created_at', { ascending: false })
          .limit(6);

        if (!spaces || spaces.length === 0) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ በአሁኑ ጊዜ የሚገኙ ክፍሎች የሉም። እባክዎን በኋላ እንደገና ይሞክሩ።',
          });
          return NextResponse.json({ ok: true });
        }

        const buttons = spaces.map((s) => [
          {
            text: `🛒 ${s.title} - ${s.neighborhood} (${s.unlock_fee || 50} ብር)`,
            callback_data: `start_order_direct:${s.id}`,
          },
        ]);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '<b>🛒 ለማዘዝ የሚፈልጉትን ክፍል ይምረጡ፡</b>\n\nከታች ከተዘረዘሩት ክፍሎች አንዱን በመጫን የባለቤቱን ስልክ ቁጥር በቴሌብር ክፍያ ማግኘት ይችላሉ።',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        });

        return NextResponse.json({ ok: true });
      }

      // 2.1.1 /start order_{listing_id}
      if (text.startsWith('/start order_')) {
        const listingId = text.replace('/start order_', '').trim();
        await sendOrderCheckoutPrompt(chatId, listingId);
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
            text: '⚠️ የትዕዛዝ መረጃ አልተገኘም።',
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
🏠 <b>የቴሌብር ክፍያ ማረጋገጫ</b>

<b>ቤት፡</b> ${space?.title || 'የሚከራይ ክፍል'}
💵 <b>የአገልግሎት ክፍያ፡</b> ${order.amount} ብር

💳 <b>የቴሌብር አካውንት፡</b>
<code>${receiverPhone}</code>

እባክዎን <b>${order.amount} ብር</b> ወደ ቴሌብር ቁጥር <code>${receiverPhone}</code> አስተላልፈው የላኩበትን <b>የትራንዛክሽን ቁጥር (Txn Ref / FT...)</b> እዚህ መልሰው ይፃፉ፡
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
            text: '⚠️ የተመዘገበው ቤት መረጃ አልተገኘም።',
          });
          return NextResponse.json({ ok: true });
        }

        const rejectionReason = text || 'የቀረበው መረጃ ከመመሪያው ጋር አይስማማም።';
        draft.status = 'rejected';
        draft.rejection_reason = rejectionReason;
        saveDraft(draft);

        clearSession(chatId);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>✅ ውድቅ ማድረጉ ተመዝግቧል!</b>\n\nምክንያት፡ <i>"${rejectionReason}"</i>\nማሳወቂያው ለቤት ባለቤቱ ተልኳል።`,
          parse_mode: 'HTML',
        });

        const homeownerRejectMessage = `
<b>❌ የቤት መዝገባ ማሳወቂያ</b>

ለ<b>${draft.title}</b> ያቀረቡት መረጃ በአስተዳዳሪዎች አልጸደቀም።

<b>ምክንያት፡</b>
<i>${rejectionReason}</i>

እባክዎን መረጃውን አስተካክለው ከታች ያለውን ቁልፍ በመጫን እንደገና ይመዝግቡ።
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: draft.homeowner_telegram_id,
          text: homeownerRejectMessage,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔄 እንደገና መዝግብ',
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
            text: '⚠️ የትዕዛዝ መረጃ አልተገኘም።',
          });
          return NextResponse.json({ ok: true });
        }

        const space = order.spaces;
        const txRef = text.trim();

        if (!txRef) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ እባክዎን የቴሌብር ትራንዛክሽን ቁጥሩን ይፃፉ።',
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
            text: '⚠️ <b>ማሳወቂያ፡</b> ይህ የቴሌብር ትራንዛክሽን ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል።',
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        // Verify transaction reference with verify.et API
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `⏳ <b>ትራንዛክሽን <code>${txRef}</code> በverify.et እየተረጋገጠ ነው...</b>`,
          parse_mode: 'HTML',
        });

        const verifyResult = await verifyTelebirrPayment(txRef, Number(order.amount));

        if (!verifyResult.success) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: `❌ <b>የክፍያ ማረጋገጫ አልተሳካም፡</b> ${verifyResult.message}\n\nእባክዎን ትራንዛክሽን ቁጥሩን አስተካክለው እንደገና ይፃፉ።`,
            parse_mode: 'HTML',
          });
          return NextResponse.json({ ok: true });
        }

        // Mark order completed in DB
        await supabaseAdmin
          .from('orders')
          .update({
            transaction_reference: txRef,
            payment_status: 'completed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        clearSession(chatId);

        // Send unlocked contact details
        await sendUnlockedContactDetails(chatId, space);
        return NextResponse.json({ ok: true });
      }

      // -----------------------------------------------------------------------
      // 2.4 HOMEOWNER LISTING STEP-BY-STEP WIZARD ENGINE
      // -----------------------------------------------------------------------

      // Step 1 -> Step 2 (Title -> Neighborhood)
      if (session.step === 'awaiting_title') {
        if (!text) {
          await sendTelegram('sendMessage', {
            chat_id: chatId,
            text: '⚠️ እባክዎን የቤቱን ስም/ርዕስ ያስገቡ።',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.title = text;
        session.step = 'awaiting_neighborhood';
        saveSession(session);

        const prompt = `
<b>📍 ደረጃ 2/6፡ የቤቱ አካባቢ (ሰፈር)</b>

ቤቱ የሚገኝበትን አካባቢ ያስገቡ።
<i>ምሳሌ፡ "ቦሌ አትላስ"፣ "ካዛንችስ"፣ "4 ኪሎ"፣ "መገናኛ"</i>
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
            text: '⚠️ እባክዎን ቤቱ የሚገኝበትን አካባቢ ያስገቡ።',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.neighborhood = text;
        session.step = 'awaiting_price';
        saveSession(session);

        const prompt = `
<b>💵 ደረጃ 3/6፡ ወርሃዊ የኪራይ ዋጋ (በብር)</b>

ወርሃዊ የኪራይ ዋጋው ስንት ብር ነው?
<i>እባክዎን ቁጥር ብቻ ያስገቡ (ምሳሌ፡ 12500)።</i>
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
            text: '⚠️ እባክዎን ትክክለኛ የኪራይ ዋጋ ቁጥር ብቻ ያስገቡ (ምሳሌ፡ 12500)።',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.price_per_month = price;
        session.step = 'awaiting_description';
        saveSession(session);

        const prompt = `
<b>📝 ደረጃ 4/6፡ የቤቱ መግለጫና መገልገያዎች</b>

ስለ ቤቱ ዝርዝር መረጃ ያስገቡ (መታጠቢያ ቤት፣ ዋይፋይ፣ የውሃ ታንከር፣ መኪና ማቆሚያ ወዘተ)።
<i>ምሳሌ፡ "የራሱ መታጠቢያ ቤት ያለው፣ ዋይፋይ፣ የውሃ ታንከር፣ ሰላማዊ አካባቢ።"</i>
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
            text: '⚠️ እባክዎን ስለ ቤቱ መግለጫ ያስገቡ።',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.description = text;
        session.step = 'awaiting_address_phone';
        saveSession(session);

        const prompt = `
<b>📞 ደረጃ 5/6፡ ትክክለኛ አድራሻና የስልክ ቁጥር</b>

እባክዎን ትክክለኛውን የቤት አድራሻ እና የተከራዮች የሚያገኙበትን ስልክ ቁጥር ያስገቡ።
<i>ምሳሌ፡ "ቦሌ አትላስ ኤድናሞል ጀርባ፣ ስልክ፡ 0911223344"</i>
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
            text: '⚠️ እባክዎን አድራሻዎንና ስልክ ቁጥርዎን ያስገቡ።',
          });
          return NextResponse.json({ ok: true });
        }

        session.draft_data.exact_address = text;
        session.draft_data.contact_phone = text;
        session.step = 'awaiting_photo';
        saveSession(session);

        const prompt = `
<b>📸 ደረጃ 6/6፡ የቤቱ ፎቶ</b>

በመጨረሻም! እባክዎን የክፍሉን ወይም የቤቱን ግልጽ ፎቶ ይላኩ።
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
            text: '⚠️ እባክዎን ምዝገባውን ለማጠናቀቅ የቤቱን ፎቶ ይላኩ።',
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
        const homeownerName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 'የቤት ባለቤት';

        const draft: SpaceDraft = {
          id: draftId,
          homeowner_telegram_id: fromUser.id,
          homeowner_name: homeownerName,
          homeowner_username: fromUser.username || null,
          title: session.draft_data.title || 'ያልተሰየመ ቤት',
          neighborhood: session.draft_data.neighborhood || 'አዲስ አበባ',
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
<b>✅ የቤትዎ መረጃ በደህና ደርሶናል!</b>

የመዘገቡት ቤት <b>${draft.title}</b> በአስተዳዳሪዎች እየተገመገመ ነው።

እንደተረጋገጠ ወዲያውኑ ማሳወቂያ እንልክልዎታለን!
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: userConfirmation,
          parse_mode: 'HTML',
        });

        const adminIds = await getAdminIds();
        const adminCaption = `
<b>🏠 አዲስ የሚከራይ ቤት መዝገባ ለግምገማ</b>

<b>ርዕስ፡</b> ${draft.title}
<b>አካባቢ፡</b> ${draft.neighborhood}
<b>ወርሃዊ ኪራይ፡</b> ${draft.price_per_month} ብር / በወር
<b>መግለጫ፡</b> ${draft.description}
<b>አድራሻና ስልክ፡</b> ${draft.exact_address}
<b>አስመዝጋቢ፡</b> ${draft.homeowner_name} (@${draft.homeowner_username || 'N/A'})

<i>እባክዎን ይመልከቱና ከታች ካሉት አማራጮች ይምረጡ፡</i>
        `.trim();

        const adminKeyboard = {
          inline_keyboard: [
            [
              {
                text: '✅ አጽድቅና ለጥፍ',
                callback_data: `space_approve:${draftId}`,
              },
            ],
            [
              {
                text: '❌ ውድቅ አድርግ',
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
      // 2.5 EXTENDED TELEGRAM BOT COMMAND HANDLERS IN AMHARIC
      // -----------------------------------------------------------------------

      // Room Matching Wizard Text Steps
      if (session.step === 'awaiting_match_neighborhood') {
        const hood = text.trim();
        saveSession({
          telegram_id: chatId,
          step: 'awaiting_match_budget',
          draft_data: { neighborhood: hood },
          updated_at: new Date().toISOString(),
        });

        const step2Msg = `
💵 <b>ደረጃ 2/3፡ በወር መክፈል የሚችሉት ከፍተኛው ክፍያ (በጀት) ስንት ነው?</b>

አካባቢ፡ <b>${hood}</b>

እባክዎን የገንዘብ መጠኑን በብር ይፃፉ (ምሳሌ፡ 10000 ወይም 15000) ወይም ከታች ካሉት ይምረጡ፡
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: step2Msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💵 እስከ 5,000 ብር', callback_data: 'match_budget:5000' },
                { text: '💵 እስከ 10,000 ብር', callback_data: 'match_budget:10000' },
              ],
              [
                { text: '💵 እስከ 15,000 ብር', callback_data: 'match_budget:15000' },
                { text: '💵 እስከ 25,000 ብር', callback_data: 'match_budget:25000' },
              ],
              [
                { text: '💵 ማንኛውም በጀት', callback_data: 'match_budget:0' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (session.step === 'awaiting_match_budget') {
        const budget = parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
        const draftData: Record<string, any> = { ...session.draft_data, max_budget: budget };

        saveSession({
          telegram_id: chatId,
          step: 'awaiting_match_room_type',
          draft_data: draftData,
          updated_at: new Date().toISOString(),
        });

        const step3Msg = `
🏠 <b>ደረጃ 3/3፡ የሚፈልጉት የክፍል ዓይነት የትኛው ነው?</b>

አካባቢ፡ <b>${draftData.neighborhood}</b>
በጀት፡ <b>${budget > 0 ? `${budget.toLocaleString()} ብር` : 'ማንኛውም'}</b>

ከታች ከተዘረዘሩት የክፍል ዓይነቶች አንዱን ይምረጡ ወይም ይፃፉ፡
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: step3Msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🏠 ስቱዲዮ (Studio)', callback_data: 'match_type:Studio' },
                { text: '🬀 ባለ 1 መኝታ (Single Bed)', callback_data: 'match_type:Single' },
              ],
              [
                { text: '🛏️ ማስተር ቤድሩም (Master)', callback_data: 'match_type:Master' },
                { text: '👥 የጋራ ክፍል (Shared)', callback_data: 'match_type:Shared' },
              ],
              [
                { text: '✨ ማንኛውም ዓይነት', callback_data: 'match_type:Any' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      if (session.step === 'awaiting_match_room_type') {
        const searchData = {
          neighborhood: session.draft_data.neighborhood,
          max_budget: session.draft_data.max_budget,
          room_type: text.trim(),
        };

        clearSession(chatId);
        await executeRoomSearchAndSendResults(chatId, searchData);
        return NextResponse.json({ ok: true });
      }

      // /match or /find command
      if (text === '/match' || text === '/find' || text.startsWith('/match')) {
        saveSession({
          telegram_id: chatId,
          step: 'awaiting_match_neighborhood',
          draft_data: {},
          updated_at: new Date().toISOString(),
        });

        const step1Msg = `
🎯 <b>ደረጃ 1/3፡ መከራየት የሚፈልጉበትን አካባቢ ይምረጡ ወይም ይፃፉ</b>

ምሳሌ፡ ቦሌ, ካዛንችስ, ሳርቤት, ፒያሳ, 4 ኪሎ...

<i>(ለማቆም /cancel ይፃፉ)</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: step1Msg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📍 ቦሌ (Bole)', callback_data: 'match_hood:Bole' },
                { text: '📍 ካዛንችስ (Kazanchis)', callback_data: 'match_hood:Kazanchis' },
              ],
              [
                { text: '📍 ሳርቤት (Sarbet)', callback_data: 'match_hood:Sarbet' },
                { text: '📍 4 ኪሎ (4 Kilo)', callback_data: 'match_hood:4 Kilo' },
              ],
              [
                { text: '📍 ፒያሳ (Piassa)', callback_data: 'match_hood:Piassa' },
                { text: '🌐 ማንኛውም አካባቢ', callback_data: 'match_hood:Any' },
              ],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // /browse or /search command
      if (text === '/browse' || text === '/search') {
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: `<b>🔍 በኣዲስ አበባ ያሉ ክፍሎችን ይመልከቱ</b>\n\nየተዘጋጁትን ክፍሎች በሚኒ አፑ ላይ ለማየት ከታች ያለውን ቁልፍ ይጫኑ!`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🏪 SpaceMatch ሚኒ አፕ ክፈት',
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
        const { data: userRecord } = await supabaseAdmin
          .from('users')
          .select('phone_number')
          .eq('telegram_id', chatId)
          .maybeSingle();

        if (!userRecord || !userRecord.phone_number) {
          await triggerPhoneRegistrationPrompt(chatId);
          return NextResponse.json({ ok: true });
        }

        saveSession({
          telegram_id: chatId,
          step: 'awaiting_title',
          draft_data: { homeowner_phone: userRecord.phone_number, contact_phone: userRecord.phone_number },
          updated_at: new Date().toISOString(),
        });
        const promptText = `
<b>🏠 ደረጃ 1/6፡ የቤቱ/ክፍሉ ስም (ርዕስ)</b>

እባክዎን የክፍልዎን ወይም የቤትዎን አጭር መግለጫ ስም ያስገቡ።
<i>ምሳሌ፡ "በቦሌ የሚከራይ ባለ 1 መኝታ ቤት" ወይም "በካዛንችስ የሚከራይ ስቱዲዮ"</i>

<i>(ለማቆም /cancel ይፃፉ)</i>
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
            text: `<b>📂 የከፈቷቸው አድራሻዎች</b>\n\nእስካሁን የክፈቱት የቤት ባለቤት ስልክ ቁጥር የለም።\n\nበሚኒ አፑ ላይ ያሉትን ክፍሎች በመመልከት በ50 ብር አድራሻ ይክፈቱ!`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 አሁኑኑ ክፍሎችን ይመልከቱ', web_app: { url: appUrl } }],
              ],
            },
          });
          return NextResponse.json({ ok: true });
        }

        let msg = `<b>📂 የከፈቷቸው የቤት ባለቤቶች አድራሻዎች (${userOrders.length})</b>\n\n`;
        userOrders.forEach((o: any, idx: number) => {
          const s = o.spaces;
          if (s) {
            msg += `${idx + 1}. <b>${s.title}</b> (${s.neighborhood})\n`;
            msg += `📍 አድራሻ፡ ${s.exact_address}\n`;
            msg += `📞 ስልክ፡ ${s.contact_name} (${s.contact_phone})\n`;
            msg += `💬 ቴሌግራም፡ ${s.contact_telegram || 'የለም'}\n\n`;
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
        const statusBadge = status === 'verified' ? '✅ ተረጋግጧል' : '⚠️ ገና አልተረጋገጠም';

        const verifyMsg = `
<b>🆔 የፋይዳ ብሔራዊ መታወቂያ ማረጋገጫ</b>

<b>የአሁኑ ሁኔታ፡</b> ${statusBadge}

የተረጋገጡ ተከራዮች የቤት ባለቤቶችን ስልክ ቁጥርና አድራሻ በቀላሉ ማግኘት ይችላሉ።
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: verifyMsg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🆔 የፋይዳ መታወቂያ በሚኒ አፕ ስቀል', web_app: { url: appUrl } }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // /help
      if (text === '/help') {
        const helpText = `
<b>❓ SpaceMatch መመሪያና እርዳታ</b>

<b>🔍 ለተከራዮች፡</b>
1. <b>"ክፍል እፈልጋለሁ"</b> የሚለውን ይጫኑ ወይም /browse በመፃፍ ሚኒ አፑን ይክፈቱ።
2. ክፍሎችን በአካባቢና በዓይነት ይፈልጉ።
3. የባለቤቱን ስልክ ለማግኘት <b>"ስልክ ክፈት"</b> የሚለውን በመጫን 50 ብር በቴሌብር ይክፈሉ።
4. ክፍያው እንደተረጋገጠ የባለቤቱ ስልክና የጉግል ማፕ አድራሻ ይከፈታል!

<b>🏠 ለቤት አከራዮች፡</b>
1. <b>"ማከራየት እፈልጋለሁ"</b> የሚለውን ይጫኑ ወይም /post ብለው ይፃፉ።
2. የቤቱን ስልክ፣ ዋጋ፣ አካባቢ እና መግለጫ ያስገቡ።
3. የቤቱን ፎቶ ይላኩ።
4. በአስተዳዳሪዎች ሲጸድቅ ቤትዎ በሚኒ አፕና በቴሌግራም ቻነል ላይ ይታተማል!

<b>📜 የትእዛዞች ዝርዝር፡</b>
/start - መነሻ ገጽና ዋና ማውጫ
/browse - ክፍሎችን በሚኒ አፕ መመልከቻ
/post - የሚከራይ ቤት መመዝገቢያ
/myorders - የከፈቷቸው አድራሻዎች
/verify - የፋይዳ መታወቂያ ማረጋገጫ
/support - የአስተዳዳሪዎች እርዳታ
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
<b>💬 የSpaceMatch እርዳታና ድጋፍ</b>

ጥያቄ ወይም እርዳታ ይፈልጋሉ?

<b>አስተዳዳሪዎች፡</b>
• @birukadiyee
• @WWEHID

<i>የስራ ሰዓት፡ 2:00 ጠዋት - 4:00 ማታ</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: supportText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 አስተዳዳሪውን ያናግሩ', url: 'https://t.me/birukadiyee' }],
            ],
          },
        });
        return NextResponse.json({ ok: true });
      }

      // /broadcast <listing_id> (Admin Only)
      if (text.startsWith('/broadcast ')) {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ ለአስተዳዳሪዎች ብቻ የተፈቀደ።' });
          return NextResponse.json({ ok: true });
        }

        const listingId = text.replace('/broadcast ', '').trim();
        const broadcastRes = await broadcastListingToChannel(listingId);

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: broadcastRes.success
            ? `<b>✅ በቻነል ተለጥፏል!</b>\n\n${broadcastRes.message}`
            : `<b>❌ መለጠፍ አልተሳካም</b>\n\n${broadcastRes.message}`,
          parse_mode: 'HTML',
        });
        return NextResponse.json({ ok: true });
      }

      // /stats (Admin Only)
      if (text === '/stats') {
        const adminIds = await getAdminIds();
        if (!adminIds.includes(chatId)) {
          await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ ለአስተዳዳሪዎች ብቻ የተፈቀደ።' });
          return NextResponse.json({ ok: true });
        }

        const { count: publishedCount } = await supabaseAdmin.from('spaces').select('*', { count: 'exact', head: true }).eq('status', 'published');
        const { count: completedOrdersCount } = await supabaseAdmin.from('orders').select('*', { count: 'exact', head: true }).eq('payment_status', 'completed');
        const { count: verifiedUsersCount } = await supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('fayda_status', 'verified');

        const totalRevenue = (completedOrdersCount || 0) * 50;

        const statsText = `
<b>📊 የSpaceMatch ሲስተም ስታቲስቲክስ</b>

🏠 <b>የታተሙ ቤቶች፡</b> ${publishedCount || 0}
🔓 <b>የተከፈቱ አድራሻዎች፡</b> ${completedOrdersCount || 0}
💵 <b>ጠቅላላ ገቢ፡</b> ${totalRevenue.toLocaleString()} ብር
🆔 <b>የተረጋገጡ ተጠቃሚዎች፡</b> ${verifiedUsersCount || 0}
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
        text.includes('ቦታ አለኝ') ||
        text.includes('ማከራየት')
      ) {
        saveSession({
          telegram_id: chatId,
          step: 'awaiting_title',
          draft_data: {},
          updated_at: new Date().toISOString(),
        });

        const promptText = `
<b>🏠 ደረጃ 1/6፡ የቤቱ/ክፍሉ ስም (ርዕስ)</b>

እባክዎን የክፍልዎን ወይም የቤትዎን አጭር መግለጫ ስም ያስገቡ።
<i>ምሳሌ፡ "በቦሌ የሚከራይ ባለ 1 መኝታ ቤት" ወይም "በካዛንችስ የሚከራይ ስቱዲዮ"</i>

<i>(ለማቆም /cancel ይፃፉ)</i>
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: promptText,
          parse_mode: 'HTML',
        });

        return NextResponse.json({ ok: true });
      }

      // Handle /start Command in Amharic
      if (text.startsWith('/start')) {
        clearSession(chatId);
        const welcomeText = `
<b>👋 እንኳን ወደ SpaceMatch ኢትዮጵያ በደህና መጡ!</b>

ክፍል መከራየት ቢፈልጉ ወይም የእርስዎን ቤት ማከራየት ቢፈልጉ፣ በአንድ ቦታ ያገኛሉ።

ለመጀመር ከታች ካሉት አማራጮች አንዱን ይምረጡ፡
        `.trim();

        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: welcomeText,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔍 ክፍል እፈልጋለሁ (ሚኒ አፕ ክፈት)',
                  web_app: { url: appUrl },
                },
              ],
              [
                {
                  text: '🏠 ማከራየት እፈልጋለሁ (ቤት መዝግብ)',
                  callback_data: 'start_listing',
                },
              ],
              [
                {
                  text: '💬 አስተዳዳሪውን ያናግሩ',
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
