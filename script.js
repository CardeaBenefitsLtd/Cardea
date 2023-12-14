document.addEventListener('DOMContentLoaded', function () {
  function addFAQ(question, completeAnswer) {
    var faqContainer = document.getElementById('faq-container');
    var faqItem = document.createElement('div');
    faqItem.className = 'faq-item';
    faqItem.innerHTML = `
      <div class="question"><span class="arrow">&#8594;</span> ${question}</div>
      <div class="answer">${completeAnswer}</div>
    `;
    faqContainer.appendChild(faqItem);

    var questionElement = faqItem.querySelector('.question');
    var answerElement = faqItem.querySelector('.answer');
    var arrowElement = faqItem.querySelector('.arrow');

    // Add transition effect to the arrow
    arrowElement.style.transition = 'transform 0.3s ease-in-out';

    // Show answer on hover and change arrow direction with transition
    questionElement.addEventListener('mouseover', function () {
      answerElement.style.display = 'block';
      arrowElement.style.transform = 'rotate(90deg)';
    });

    // Hide answer and reset arrow direction with transition when not hovering
    faqItem.addEventListener('mouseleave', function () {
      answerElement.style.display = 'none';
      arrowElement.style.transform = 'rotate(0deg)';
    });

    // Change the display to inline-block for the arrow
    arrowElement.style.display = 'inline-block';

    // Add red color and make the arrow bold
    arrowElement.style.color = 'red';
    arrowElement.style.fontWeight = 'bold';
  }
  // Add your FAQs here
  addFAQ("Who is Cardea Benefits Limited?", "Cardea Benefits Limited (Cardea) is a Third-Party Administrator for Health Benefit Plans and an Agostini Insurance Brokers Limited (AIB) subsidiary.");
  addFAQ("What services does Cardea provide?", "Cardea adjudicates medical claims and provides health benefit payment and disbursement to providers or health plan members. Cardea also offers plan members access to the overseas Providers Network.");
  addFAQ("Local providers are unable to diagnose my symptoms. How can my Health Plan and Cardea help?", "Using medical investigation reports from local providers, Cardea will refer the case to one of its overseas physicians to arrange an evaluation of the patient with the appropriate Specialist physician or multidisciplinary medical team if required.");
  addFAQ("Can I choose to do an elective procedure overseas rather than do it locally?", "Yes.");
  addFAQ("How do I access overseas treatment?", "All elective treatments must be pre-certified by Cardea before accessing out-of-country medical services. Cardea will arrange treatment/procedure within their Provider network and pay the plan's benefits directly to the in-network provider.");
  addFAQ("What documentation must I submit to have my elective overseas treatment pre-certified?", "A detailed medical report from your attending physician, including reports of any diagnostic tests must be submitted to Cardea to facilitate pre-certification.<br>The report must contain sufficient details on the patient’s medical condition to determine the specialty required at the overseas facility.");
  addFAQ("How do I notify Cardea?", "Plan members can contact Cardea at<br>• Office Hours: +1868-623-0576<br>• Outside Office hours: +1-868-715-8211 / +1-868-729-0876 / +1-868-688-3201<br>• Email: precerts@cardeabenefits.com");
  addFAQ("Why must I have my elective overseas treatment pre-certified before travel?", "If you access services within Cardea Provider's Network, your out-of-pocket share of the cost will be less. Cardea has contractual relationships with participating providers with special pricing for plan members. Cardea's pre-certification approvals are on their In-network pricing. Cardea will pay plan benefits directly to the provider on all pre-certified overseas cases, thereby lessening or eliminating the member's out-of-pocket expense.");
  addFAQ("What are out-of-network services, and do I have coverage for them?", "Out-of-network services are provided by a doctor, hospital, or other provider that does not have a contractual relationship with your health plan. If you access out-of-network services, your share of the cost is usually significantly higher than if the service was provided in the network. You will also have to pay the total price and submit a claim for reimbursement.");
  addFAQ("Is my Health Plan required to cover emergency care even if it’s out -of-network?", "Yes. Your Health Plan provides coverage for emergency services even if a particular Healthcare Provider or Hospital is not on the plan’s network.");
  addFAQ("What is the advantage of accessing treatment within the network?", "The advantage of In-network treatment is the hassle-free way to pay for a medical service. We pay our In-Network Healthcare Providers directly for any covered expenses, and you only pay any deductible and/or coinsurance due.");
  addFAQ("Which services will be covered by this plan?", "This plan covers In-patient treatment, Out-patient treatment, Emergency Assistance, Evacuation and Repatriation, Preventative Care.");
  addFAQ("Will my Health Insurance cover the costs of Coronavirus testing and treatment?", "Yes.");
  addFAQ("Which services will NOT be covered by this plan?", "This plan generally excludes coverage for:<br>• Any voluntary induced termination of pregnancy, unless medically needed.<br>• Pregnancy.<br>• Fertility treatment/examinations/tests including hormone treatment.<br>• Any non-disclosed pre-existing condition<br>• Over the Counter/Experimental or Investigative drugs or supplies<br>• Contraceptive drugs or devices<br>• Dental care, treatment, or surgery<br>• Routine eye examinations, eyeglasses or contact lenses<br>• Cosmetic Surgery inclusive of Breast Reductions<br>• Obesity or Weight control surgery<br>• Any treatment of alcoholism or drug addiction");
  addFAQ("What is the maximum amount covered under this plan?", "Each person covered under this plan has an annual maximum of USD 2,000,000. This limit is refreshed yearly and is available to Active and Retired Managers/Directors.");
  addFAQ("Does the Plan have a deductible?", "Yes. The plan's deductible for Active and Retired Managers/Directors is USD 20,000 per calendar year or USD 40,000 per family per calendar year. Cardea will pay benefits under this plan after the deductible has been satisfied.");
  addFAQ("Can the deductible be settled under the local Group Health Plan?", "Yes. Claims are settled under the Local Group Health Plan first.");
  addFAQ("What do I do if I have an emergency overseas?", "Please go directly to an emergency facility. If the emergency results in hospitalization, contact Cardea's Emergency call centre COLLINSON CRISIS 24 (See your Digital ID Card for details). COLLINSON CRISIS 24 will commit the liability at the time of service. The patient will be responsible for their share of the cost. If the emergency does not result in hospitalization, the patient is responsible for 100% of the cost at the time of service and can then submit a claim for reimbursement in the usual manner.");
 addFAQ('Were there any benefit adjustments when the plan was switched to Cardea?', `
    <p>The following benefit enhancements were made when the plan was switched to Cardea:</p>
    <table class="styled-table">
      <tr>
        <th>Benefits</th>
        <th>Expiring Limit</th>
        <th>Enhanced Limit</th>
      </tr>
      <tr>
        <td><b>Congenital Conditions (Lifetime Maximum)</b></td>
        <td></td>
        <td></td>
      </tr>
      <tr>
        <td>For conditions manifested on or after 18th birthday</td>
        <td>USD 1,000,000 Lifetime</td>
        <td>USD 2,000,000 Lifetime</td>
      </tr>
      <tr>
        <td>Waiting period of 12 months for new enrollees</td>
        <td>USD 1,000,000 Lifetime</td>
        <td>USD 2,000,000 Lifetime</td>
      </tr>
      <tr>
        <td><b>Continuation of Coverage</b></td>
        <td></td>
        <td></td>
      </tr>
      <tr>
        <td>Dependent Spouses and Children of Deceased employees</td>
        <td>Not Available</td>
        <td>Coverage continued for up to 2 years (subject to payment of premiums)</td>
      </tr>
      <tr>
        <td><b>Extension of Coverage</b></td>
        <td></td>
        <td></td>
      </tr>
      <tr>
        <td>Incapacitated Children solely dependent on the employee</td>
        <td>Not Available</td>
        <td>Coverage extended so long as the employee remains covered.</td>
      </tr>
    </table>
`);
  addFAQ("Were there any adjustments in my annual premium?", `
    <p>Yes, premiums were reduced when the switch to Cardea was made.</p>
    <table class="styled-table">
      <tr>
        <th style="text-align: center;">Category</th>
        <th colspan = "2" style="text-align: center;">Annual Premium</th>
        
      </tr>
      <tr>
        <td></td>
    
        <td style="text-align: center;">2023 Premium</td>
        <td style="text-align: center;">2024 Premium</td>
      </tr>
      <tr>
        <td><b>Managers/Directors Only</b></td>
        <td style="text-align: center;">USD 752.00</td>
        <td style="text-align: center;">USD 725.00</td>
     
      </tr>
      <tr>
        <td><b>Managers/Directors & One</b></td>
        <td style="text-align: center;">USD 1,350.00</td>
        <td style="text-align: center;">USD 1,301.00</td>
  
      </tr>
      <tr>
        <td><b>Managers/Directors & Family</b></td>
        <td style="text-align: center;">USD 2,231.00</td>
        <td style="text-align: center;">USD 2,149.00</td>
 
      </tr>
    </table>
    <br>
    <table class="styled-table">
      <tr>
        <th style="text-align: center;">Category</th>
        <th colspan = "2" style="text-align: center;">Annual Premium</th>
    
      </tr>
      <tr>
        <td></td>
     
        <td style="text-align: center;">2023 Premium</td>
        <td style="text-align: center;">2024 Premium</td>
      </tr>
      <tr>
        <td><b>Managers/Directors Only</b></td>
        <td style="text-align: center;">USD 1,238.04</td>
        <td style="text-align: center;">USD 1,192.00</td>
   
      </tr>
      <tr>
        <td><b>Managers/Directors & One</b></td>
        <td style="text-align: center;">USD 2,415.84</td>
        <td style="text-align: center;">USD 2,326.00</td>
       
      </tr>
      <tr>
        <td><b>Managers/Directors & Family</b></td>
        <td style="text-align: center;">USD 3,654.64</td>
        <td style="text-align: center;">USD 3,519.00</td>
      </tr>
    </table>
  `);
  addFAQ("Can I add my spouse and children to the plan?", "Yes, legally married spouses and common law spouses can be added to the plan. In addition to unmarried children (including stepchildren and legally adopted children) up to age 21. Coverage is extended for unmarried children to age 25 if attending tertiary education and proof of attendance is needed yearly.");
  addFAQ("How long can I and my spouse remain on the plan?", "Active staff and their spouse coverage continue up to retirement age. After retirement, retired staff and spouses can continue in the plan provided the premiums payment continues.");
  addFAQ("How long can my child remain on the plan?", "Unmarried children can remain on the plan up to age 21. Coverage is extended for unmarried children to age 25, provided the child is in a tertiary educational institution. The primary insured member must provide proof of full-time attendance for each semester. Incapacitated children can remain on the plan once coverage for the primary insured member remains active.");
  addFAQ("Can dependent children and spouse remain on the plan after the death of an employee or retired employee?", "Yes. Coverage will continue up to two years following the death of the primary member (Employee/Retired employee). The surviving dependents/spouse must continue to pay premiums.");
  addFAQ("Will coverage under this plan continue if I or my dependents are living outside of Trinidad and Tobago for more than 6 months?", "No. Coverage will terminate if the insured member or dependents of the insured member live outside of Trinidad and Tobago for more than six months.");
  addFAQ("Where can I file a complaint if I’m having problems with my insurance?", "If you’re unsatisfied with your Health Plan’s services or your claim has been denied, call the member services phone number on your member card. You may be able to resolve your concern over the phone, or you can file a complaint with the Bank’s Compensation and Benefits section.<br> Further, you can send an email to: claimqueries@cardeabenefits.com");

});
