# Demo blog posts

Fictional sample articles for the FairSource demo. Paste them into a test blog you own (for example a free Blogger blog), so you can show a connect, an edit and a delete live. Everything here is made up for the demo: names, figures and dates are not real news.

Suggested blog name: **Pune Local Demo** (`punelocaldemo.blogspot.com`, or whatever is free).

The demo question these posts are written for, asked in Hindi: **पुणे मेट्रो का नया रूट क्या है?**

---

## Post 1 (Marathi): पुणे शहरात नवीन मेट्रो मार्ग

हिंजवडी ते शिवाजीनगर या नव्या मेट्रो मार्गाचे काम अंतिम टप्प्यात असल्याचे अधिकाऱ्यांनी सांगितले. हा मार्ग सुमारे २३ किलोमीटर लांबीचा असून त्यावर २३ स्थानके असतील.

बालेवाडी, बाणेर आणि विद्यापीठ चौक ही या मार्गावरील प्रमुख स्थानके असतील. नव्या मार्गामुळे आयटी पार्कमधील कर्मचाऱ्यांच्या प्रवासाचा वेळ कमी होईल, अशी अपेक्षा आहे.

पहिला टप्पा पुढील वर्षी नागरिकांसाठी खुला करण्यात येईल, असे मेट्रो प्रशासनाने सांगितले. सकाळी आणि संध्याकाळी गर्दीच्या वेळेत दर सहा मिनिटांनी गाडी धावेल.

स्थानकांजवळ सायकल आणि ई-रिक्षा सेवा उपलब्ध करून देण्याचे नियोजनही करण्यात आले आहे.

---

## Post 2 (Marathi): मेट्रो कामामुळे हिंजवडी परिसरात वाहतुकीत बदल

मेट्रोच्या कामामुळे हिंजवडी आणि वाकड परिसरातील काही रस्त्यांवर वाहतूक वळवण्यात आली आहे. पुढील दोन महिने हे बदल लागू राहतील, असे वाहतूक पोलिसांनी सांगितले.

लक्ष्मी चौक ते शिवाजी चौक हा रस्ता रात्री दहा ते सकाळी सहा या वेळेत बंद राहील. या काळात वाहनचालकांनी पर्यायी मार्गाचा वापर करावा, असे आवाहन करण्यात आले आहे.

आयटी कंपन्यांनी कर्मचाऱ्यांना कार्यालयात येण्याच्या वेळेत लवचिकता द्यावी, अशी विनंतीही प्रशासनाने केली आहे.

---

## Post 3 (Hindi): पुणे मेट्रो: नए स्टेशनों की सूची जारी

पुणे मेट्रो प्रशासन ने हिंजवडी से शिवाजीनगर मार्ग के नए स्टेशनों की सूची जारी की है। इस मार्ग पर कुल तेईस स्टेशन होंगे।

बालेवाडी, बाणेर और विद्यापीठ चौक इस मार्ग के प्रमुख स्टेशन होंगे। प्रशासन के अनुसार पहला चरण अगले साल यात्रियों के लिए खोला जाएगा।

अधिकारियों ने बताया कि सुबह और शाम के व्यस्त समय में हर छह मिनट पर मेट्रो चलेगी। स्टेशनों के पास साइकिल और ई-रिक्शा की सुविधा भी दी जाएगी।

---

## For the "edit" moment (sync demo)

After the publisher has connected the blog, edit **Post 1** on the blog and change the second paragraph to:

> बालेवाडी, बाणेर आणि विद्यापीठ चौक यांच्यासोबत आता **हिंजवडी फेज ३** हे नवे स्थानकही या मार्गावर जोडण्यात आले आहे. नव्या मार्गामुळे आयटी पार्कमधील कर्मचाऱ्यांच्या प्रवासाचा वेळ कमी होईल, अशी अपेक्षा आहे.

Then click **Sync now** on the Sources page:
- the note says **1 updated**;
- Content shows the post as **Updated · v2**;
- a buyer search for **हिंजवडी फेज ३** now finds it.

## For the "delete" moment (optional)

Delete **Post 2** on the blog, then run the daily sweep now from Cloud Shell:

```
gcloud scheduler jobs run sweep-sources --location=asia-south1
```

Within a minute Post 2 shows **Withdrawn · removed from your site**, and searches no longer return it.

## Questions to ask in the demo

| Ask in | Question | Should find |
|---|---|---|
| Hindi | पुणे मेट्रो का नया रूट क्या है? | Post 1 (Marathi) and Post 3 (Hindi) |
| English | Which stations are on the new Pune metro line? | Posts 1 and 3 |
| Marathi | हिंजवडीमध्ये रात्री कोणता रस्ता बंद आहे? | Post 2 |
| English (unrelated) | cricket world cup final score | Nothing, and nothing charged |
